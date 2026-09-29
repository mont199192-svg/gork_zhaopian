#!/usr/bin/env node
/**
 * 第 7 步：字幕 / 转场 / 配乐 / 音效。npm run compose [-- 项目]
 *
 * 零花费，纯本地 FFmpeg。
 *
 * 和 edit.js 的区别：edit.js 是硬切拼接，只为了尽快看到一条完整的片子；
 * 这一步是真正的成片加工，一次 filter_complex 里完成转场 + 字幕 + 音频，
 * 只编码一次，避免多次转码累积损失。
 *
 * 输出到 work/，成片仍然要等第 10 步才进 outputs/。
 *
 * 配乐和音效需要你自己放素材进 assets/：
 *   assets/music/*.mp3     背景音乐（取第一个，自动循环并裁到片长）
 *   assets/sfx/<镜头id>-*  音效（按文件名匹配镜头，落在该镜头开头）
 * 没有素材就输出静音片，不报错。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, basename, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { log } from './logger.js';
import { resolveProject, loadShots, projectPaths } from './project.js';
import { Ledger } from './jobs.js';
import { probe, describeVideo, checkFfmpeg } from './ffprobe.js';
import { uniquePath, humanSize, fileSize } from './download.js';
import { buildAss, resolveCueTimes } from './ass.js';

const exec = promisify(execFile);

const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus']);

function parseArgs(argv) {
  const args = {
    project: null,
    transition: 'fade',
    transitionSec: 0.5,
    noSubs: false,
    noTransition: false,
    noMusic: false,
    noVo: false,
    musicDb: -18,
    voDb: 0,
    duckDb: -10,
    crf: 18,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-subs') args.noSubs = true;
    else if (a === '--no-transition') args.noTransition = true;
    else if (a === '--no-music') args.noMusic = true;
    else if (a === '--no-vo') args.noVo = true;
    else if (a === '--transition') args.transition = argv[++i];
    else if (a === '--transition-sec') args.transitionSec = Number(argv[++i]);
    else if (a === '--music-db') args.musicDb = Number(argv[++i]);
    else if (a === '--vo-db') args.voDb = Number(argv[++i]);
    else if (a === '--duck-db') args.duckDb = Number(argv[++i]);
    else if (a === '--crf') args.crf = Number(argv[++i]);
    else if (a === '--') continue;
    else if (!a.startsWith('--')) args.project = a;
    else throw new Error(`不认识的参数 "${a}"。`);
  }
  if (!Number.isFinite(args.transitionSec) || args.transitionSec < 0 || args.transitionSec > 2) {
    throw new Error(`--transition-sec 必须在 0 到 2 之间，收到 ${args.transitionSec}。`);
  }
  if (!Number.isFinite(args.crf) || args.crf < 0 || args.crf > 51) {
    throw new Error(`--crf 必须在 0 到 51 之间，收到 ${args.crf}。`);
  }
  return args;
}

async function run(bin, args, label) {
  try {
    const { stderr } = await exec(bin, args, { maxBuffer: 50 * 1024 * 1024 });
    return { ok: true, stderr };
  } catch (e) {
    throw new Error(
      `${label} 失败：\n    ${String(e.stderr ?? e.message).split('\n').slice(-15).join('\n    ')}`
    );
  }
}

/** 读 subtitles.json，没有就返回 null（不报错，字幕是可选的）。 */
function loadSubtitles(paths) {
  const file = resolve(paths.project, 'subtitles.json');
  if (!existsSync(file)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`subtitles.json 不是合法 JSON：\n    ${e.message}`);
  }
  return {
    style: raw.style ?? {},
    cues: Array.isArray(raw.cues) ? raw.cues : [],
    file,
  };
}

/** 扫 assets/ 下的音频素材。 */
function findAudio(paths) {
  const pick = (dir) => {
    const d = resolve(paths.assets, dir);
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .filter((f) => AUDIO_EXT.has(extname(f).toLowerCase()))
      .sort()
      .map((f) => resolve(d, f));
  };
  return { music: pick('music'), sfx: pick('sfx'), vo: pick('vo') };
}

/**
 * 旁白文件名里带绝对起始时间：shot-01-01-0.60s.wav → 0.60 秒处。
 * 时间直接写在文件名里，而不是重新去算字幕时间轴 —— 这样你手动换成
 * 自己录的音频时，只要保持文件名就能放在同一个位置。
 */
export function parseVoName(file) {
  const name = basename(file, extname(file));
  const m = name.match(/-([0-9]+(?:\.[0-9]+)?)s$/);
  if (!m) return null;
  const startSec = Number(m[1]);
  if (!Number.isFinite(startSec)) return null;
  return { file, startSec };
}

/**
 * 音效按文件名前缀匹配镜头：shot-02-whoosh.mp3 → shot-02。
 * 匹配不上的记进 unmatched，提示出来，不静默丢弃。
 */
function matchSfx(files, shotIds) {
  const matched = [];
  const unmatched = [];
  for (const f of files) {
    const name = basename(f, extname(f));
    // 从长到短匹配，避免 shot-1 抢走 shot-12 的音效
    const hit = [...shotIds].sort((a, b) => b.length - a.length).find((id) => name.startsWith(id));
    if (hit) matched.push({ file: f, shot: hit });
    else unmatched.push(f);
  }
  return { matched, unmatched };
}

/**
 * 计算每个镜头在成片里的起始时间。
 *
 * xfade 是交叉淡化：后一段的开头叠在前一段的结尾上，
 * 所以每加一段转场，全片就短 transitionSec 秒。
 * 字幕时间必须按这个偏移算，否则从第二个镜头起全部错位。
 */
export function computeOffsets(clips, transitionSec) {
  const offsets = new Map();
  let acc = 0;
  for (const [i, c] of clips.entries()) {
    const d = c.durationSec;
    const startSec = i === 0 ? 0 : acc - transitionSec;
    offsets.set(c.shot.id, { startSec, durationSec: d });
    acc = startSec + d;
  }
  const totalSec = acc;
  return { offsets, totalSec };
}

/**
 * 拼 filter_complex 的视频部分。
 *
 * 不用转场时走 concat 滤镜（不是 demuxer，因为我们本来就要编码一次）。
 * 用转场时逐段 xfade 串起来，offset 是「前面累积的时间减去这次重叠」。
 */
function buildVideoFilter(clips, { transition, transitionSec, useTransition, width, height }) {
  const parts = [];
  const n = clips.length;

  // 先统一规格：xfade 要求两路输入分辨率、像素格式、帧率一致
  for (let i = 0; i < n; i++) {
    parts.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p[v${i}]`
    );
  }

  if (n === 1) {
    return { filters: parts, outLabel: '[v0]' };
  }

  if (!useTransition) {
    const inputs = clips.map((_, i) => `[v${i}]`).join('');
    parts.push(`${inputs}concat=n=${n}:v=1:a=0[vcat]`);
    return { filters: parts, outLabel: '[vcat]' };
  }

  let prev = '[v0]';
  let acc = clips[0].durationSec;
  for (let i = 1; i < n; i++) {
    const out = i === n - 1 ? '[vcat]' : `[x${i}]`;
    const offset = acc - transitionSec;
    parts.push(
      `${prev}[v${i}]xfade=transition=${transition}:duration=${transitionSec}:` +
        `offset=${offset.toFixed(3)}${out}`
    );
    acc = offset + clips[i].durationSec;
    prev = out;
  }
  return { filters: parts, outLabel: '[vcat]' };
}

/**
 * 拼音频部分。素材都是静音的（第 6 步已丢弃原音轨），
 * 所以这里从零铺：背景音乐循环裁到片长，音效按镜头时间点插入。
 * 没有任何素材就返回 null，成片保持静音。
 */
function buildAudioFilter(music, sfx, vo, { totalSec, musicDb, voDb, duckDb, inputOffset, offsets }) {
  const parts = [];
  const mixIn = [];
  let idx = inputOffset;

  // ---- 旁白先拼好，因为音乐要靠它做侧链压缩 ----
  // 注意：这决定了 main() 里 -i 的顺序必须是 镜头 → 旁白 → 音乐 → 音效。
  const voLabels = [];
  for (const v of vo) {
    const delayMs = Math.round(v.startSec * 1000);
    parts.push(
      `[${idx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
        `volume=${voDb}dB,adelay=${delayMs}|${delayMs},` +
        `atrim=0:${totalSec.toFixed(3)},asetpts=N/SR/TB[avo${idx}]`
    );
    voLabels.push(`[avo${idx}]`);
    idx++;
  }

  let voMix = null;
  if (voLabels.length === 1) {
    parts.push(`${voLabels[0]}anull[avoice]`);
    voMix = '[avoice]';
  } else if (voLabels.length > 1) {
    parts.push(
      `${voLabels.join('')}amix=inputs=${voLabels.length}:duration=longest:` +
        `dropout_transition=0:normalize=0[avoice]`
    );
    voMix = '[avoice]';
  }

  if (music) {
    // 音乐可能比片子短，aloop 循环补足；再裁到片长并首尾淡入淡出
    const fadeOut = Math.max(0, totalSec - 1.5);
    parts.push(
      `[${idx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
        `aloop=loop=-1:size=2e9,atrim=0:${totalSec.toFixed(3)},asetpts=N/SR/TB,` +
        `volume=${musicDb}dB,afade=t=in:st=0:d=1.5,afade=t=out:st=${fadeOut.toFixed(3)}:d=1.5[amusic]`
    );
    idx++;

    if (voMix) {
      // 侧链压缩：旁白一出声，音乐自动让位。这是配音片的标准做法，
      // 比手动调音量准 —— 压多少、什么时候恢复都跟着人声走。
      // 旁白要分出一路当控制信号，asplit 不然流会被消耗掉。
      parts.push(`${voMix}asplit=2[avo_mix][avo_key]`);
      const ratio = Math.max(1, Math.round(Math.abs(duckDb)));
      parts.push(
        `[amusic][avo_key]sidechaincompress=threshold=0.03:ratio=${ratio}:` +
          `attack=20:release=400:makeup=1[amusic_ducked]`
      );
      mixIn.push('[amusic_ducked]');
      mixIn.push('[avo_mix]');
      voMix = null; // 已经并进 mixIn，后面不要再加一次
    } else {
      mixIn.push('[amusic]');
    }
  }

  if (voMix) mixIn.push(voMix);

  for (const s of sfx) {
    const off = offsets.get(s.shot);
    const delayMs = Math.round((off?.startSec ?? 0) * 1000);
    parts.push(
      `[${idx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
        `adelay=${delayMs}|${delayMs},atrim=0:${totalSec.toFixed(3)},asetpts=N/SR/TB[asfx${idx}]`
    );
    mixIn.push(`[asfx${idx}]`);
    idx++;
  }

  if (mixIn.length === 0) return null;

  if (mixIn.length === 1) {
    // 只有一路，改个标签就行，不必走 amix（amix 会做归一化，单路反而变小声）
    parts.push(`${mixIn[0]}aresample=48000[aout]`);
  } else {
    parts.push(
      `${mixIn.join('')}amix=inputs=${mixIn.length}:duration=longest:dropout_transition=0:normalize=0,` +
        `aresample=48000[aout]`
    );
  }

  return { filters: parts, outLabel: '[aout]', inputCount: idx - inputOffset };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (e) {
    log.error(e.message);
    process.exitCode = 1;
    return;
  }

  const bins = await checkFfmpeg();
  if (!bins.ffmpeg || !bins.ffprobe) {
    log.error('找不到 ffmpeg 或 ffprobe。请确认它们在 PATH 里。');
    process.exitCode = 1;
    return;
  }

  let projectDir, data, paths;
  try {
    projectDir = resolveProject(args.project);
    data = loadShots(projectDir);
    paths = projectPaths(projectDir);
  } catch (e) {
    log.error(e.message);
    process.exitCode = 1;
    return;
  }

  const ledger = new Ledger(projectDir);

  log.plain('');
  log.plain(`项目：${data.meta.title ?? projectDir}`);
  log.plain('─'.repeat(64));

  // ---- 收集素材 ----
  const clips = [];
  const missing = [];
  for (const shot of data.shots) {
    const rec = ledger.get(shot.id);
    let file = rec?.outputPath;
    if (!file || !existsSync(file)) {
      const guess = resolve(paths.input, `${shot.id}.mp4`);
      file = existsSync(guess) ? guess : null;
    }
    if (!file) missing.push(shot.id);
    else clips.push({ shot, file });
  }

  if (missing.length) {
    log.error(`缺少 ${missing.length} 个镜头的素材：${missing.join(', ')}`);
    log.plain('');
    log.plain('  请先生成：npm run video');
    process.exitCode = 1;
    return;
  }

  log.info(`检查 ${clips.length} 段素材…`);
  for (const c of clips) {
    const info = await probe(c.file);
    c.durationSec = info.durationSec ?? 0;
    c.width = info.width;
    c.height = info.height;
    log.plain(`      ${c.shot.id}  ${describeVideo(info)}`);
  }

  const width = clips[0].width ?? 1280;
  const height = clips[0].height ?? 720;

  // ---- 转场与时间轴 ----
  const useTransition = !args.noTransition && clips.length > 1 && args.transitionSec > 0;
  const tSec = useTransition ? args.transitionSec : 0;

  // 转场时长不能超过任何一段的长度，否则 xfade 的 offset 会算出负数
  const shortest = Math.min(...clips.map((c) => c.durationSec));
  if (useTransition && tSec >= shortest) {
    log.error(`转场 ${tSec} 秒比最短的镜头（${shortest.toFixed(2)} 秒）还长，放不下。`);
    log.plain('  用 --transition-sec 调小，或 --no-transition 关掉转场。');
    process.exitCode = 1;
    return;
  }

  const { offsets, totalSec } = computeOffsets(clips, tSec);

  // ---- 字幕 ----
  let assPath = null;
  let cueCount = 0;
  if (!args.noSubs) {
    let subs;
    try {
      subs = loadSubtitles(paths);
    } catch (e) {
      log.error(e.message);
      process.exitCode = 1;
      return;
    }

    if (!subs) {
      log.warn('没有 project/subtitles.json，这一版不加字幕。');
    } else if (subs.cues.length === 0) {
      log.warn('subtitles.json 里没有字幕条目，这一版不加字幕。');
    } else {
      const { cues, warnings } = resolveCueTimes(subs.cues, offsets);
      for (const w of warnings) log.warn(w);
      if (cues.length === 0) {
        log.warn('所有字幕条目都不可用，这一版不加字幕。');
      } else {
        if (!existsSync(paths.work)) mkdirSync(paths.work, { recursive: true });
        assPath = resolve(paths.work, 'subtitles.ass');
        writeFileSync(assPath, buildAss(cues, { width, height, style: subs.style }), 'utf8');
        cueCount = cues.length;
      }
    }
  }

  // ---- 音频素材 ----
  const { music: musicFiles, sfx: sfxFiles, vo: voFiles } = findAudio(paths);
  const music = args.noMusic ? null : (musicFiles[0] ?? null);
  const { matched: sfx, unmatched } = matchSfx(sfxFiles, data.shots.map((s) => s.id));

  // 旁白位置写在文件名末尾的 -<秒>s 里，解析不出来的不敢猜位置，跳过并报出来
  const vo = [];
  if (!args.noVo) {
    for (const f of voFiles) {
      const parsed = parseVoName(f);
      if (parsed) vo.push(parsed);
      else log.warn(`旁白 ${basename(f)} 的文件名末尾没有 "-<秒>s"，不知道该放在哪里，已跳过。`);
    }
    vo.sort((a, b) => a.startSec - b.startSec);
  }

  if (musicFiles.length > 1) {
    log.warn(`assets/music/ 里有 ${musicFiles.length} 个文件，只用第一个：${basename(musicFiles[0])}`);
  }
  for (const f of unmatched) {
    log.warn(`音效 ${basename(f)} 的文件名没有以镜头 id 开头，不知道该放在哪里，已跳过。`);
  }

  // ---- 报告 ----
  log.plain('');
  log.plain(`  成片时长：${totalSec.toFixed(2)} 秒`);
  log.plain(`  输出规格：${width}x${height} · 24fps · crf ${args.crf}`);
  log.plain(`  转场：${useTransition ? `${args.transition} ${tSec} 秒 × ${clips.length - 1} 处` : '无（硬切）'}`);
  log.plain(`  字幕：${cueCount ? `${cueCount} 条，烧进画面` : '无'}`);
  log.plain(`  旁白：${vo.length ? `${vo.length} 段  ${args.voDb}dB` : '无'}`);
  log.plain(`  配乐：${music ? `${basename(music)}  ${args.musicDb}dB` : '无'}`);
  if (music && vo.length) {
    log.plain(`  自动让位：旁白出声时音乐压低（ratio ${Math.max(1, Math.round(Math.abs(args.duckDb)))}）`);
  }
  log.plain(`  音效：${sfx.length ? sfx.map((s) => `${basename(s.file)}→${s.shot}`).join(', ') : '无'}`);
  if (!music && sfx.length === 0 && vo.length === 0) {
    log.plain('');
    log.warn('assets/ 下的 music/ sfx/ vo/ 都是空的，成片没有声音。');
    log.plain('  放音频文件进去再跑一次就能加上，视频部分不用重做。');
  }

  // ---- 组装 ffmpeg 命令 ----
  if (!existsSync(paths.work)) mkdirSync(paths.work, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = uniquePath(resolve(paths.work, `composed-${stamp}.mp4`));

  // 顺序必须和 buildAudioFilter 里的 idx 递增顺序一致：镜头 → 旁白 → 音乐 → 音效
  const inputs = [];
  for (const c of clips) inputs.push('-i', c.file);
  for (const v of vo) inputs.push('-i', v.file);
  if (music) inputs.push('-i', music);
  for (const s of sfx) inputs.push('-i', s.file);

  const vf = buildVideoFilter(clips, {
    transition: args.transition,
    transitionSec: tSec,
    useTransition,
    width,
    height,
  });

  const filters = [...vf.filters];
  let vLabel = vf.outLabel;

  if (assPath) {
    // Windows 路径要给 ffmpeg 滤镜转义：反斜杠→正斜杠，冒号要转义
    const esc = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');
    filters.push(`${vLabel}subtitles='${esc}'[vsub]`);
    vLabel = '[vsub]';
  }

  const af = buildAudioFilter(music, sfx, vo, {
    totalSec,
    musicDb: args.musicDb,
    voDb: args.voDb,
    duckDb: args.duckDb,
    inputOffset: clips.length,
    offsets,
  });
  if (af) filters.push(...af.filters);

  const ffArgs = [
    '-y', '-hide_banner',
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', vLabel,
  ];

  if (af) {
    ffArgs.push('-map', af.outLabel, '-c:a', 'aac', '-b:a', '192k');
  } else {
    ffArgs.push('-an');
  }

  ffArgs.push(
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', String(args.crf),
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outPath
  );

  log.plain('');
  log.info('合成中…（转场和字幕要重新编码，比拼接慢）');

  try {
    await run('ffmpeg', ffArgs, '合成');
  } catch (e) {
    log.error(e.message);
    log.plain('');
    log.plain('  滤镜链写在 work/ 的日志里没有保存，可以加 --no-transition 或 --no-subs 缩小范围排查。');
    process.exitCode = 1;
    return;
  }

  // ---- 校验 ----
  const outInfo = await probe(outPath);

  log.plain('');
  log.plain('═'.repeat(64));
  log.ok(`合成完成：${outPath.replace(projectDir, '.')}`);
  log.plain(`  ${describeVideo(outInfo)}  ${humanSize(fileSize(outPath) ?? 0)}`);

  const drift = Math.abs((outInfo.durationSec ?? 0) - totalSec);
  if (drift > 0.5) {
    log.plain('');
    log.warn(`成品时长 ${outInfo.durationSec?.toFixed(2)} 秒与预计 ${totalSec.toFixed(2)} 秒相差 ${drift.toFixed(2)} 秒。`);
  }

  log.plain('');
  log.plain('  这一版放在 work/ 里，还不是最终成片。');
  log.plain('  下一步看预览：npm run preview');
  log.plain('');
}

export { parseArgs, matchSfx, loadSubtitles, buildVideoFilter, buildAudioFilter };

// 只有直接运行才执行 main，被 import 时不跑（测试要用）。
// 必须用 pathToFileURL 比对：import.meta.url 会把中文路径百分号编码，
// 手拼 `file:///` + argv[1] 在「视频剪辑」这种目录下永远对不上。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    log.error(e.message);
    process.exitCode = 1;
  });
}
