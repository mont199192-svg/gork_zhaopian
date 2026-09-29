#!/usr/bin/env node
/**
 * FFmpeg 拼接。npm run edit [-- 项目]
 *
 * 零花费。把已下载的镜头按 shots.json 顺序硬切拼成一条。
 *
 * 先用纯 FFmpeg 跑通全流程，拿到第一条能看的成片。
 * 字幕和图形层留给 Remotion（第 7 步），那时再装依赖。
 *
 * 输出到 work/，不是 outputs/ —— 成片要等你看过预览再导。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { log } from './logger.js';
import { resolveProject, loadShots, projectPaths } from './project.js';
import { Ledger } from './jobs.js';
import { probe, describeVideo, checkFfmpeg } from './ffprobe.js';
import { uniquePath, humanSize, fileSize } from './download.js';

const exec = promisify(execFile);

function parseArgs(argv) {
  const args = { project: null, reencode: false, mute: false };
  for (const a of argv.slice(2)) {
    if (a === '--reencode') args.reencode = true;
    else if (a === '--mute') args.mute = true;
    else if (!a.startsWith('--')) args.project = a;
  }
  return args;
}

/** concat demuxer 的清单文件。路径里的单引号要转义。 */
function writeConcatList(listPath, files) {
  const lines = files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`);
  writeFileSync(listPath, lines.join('\n') + '\n', 'utf8');
}

async function run(bin, args, label) {
  try {
    const { stderr } = await exec(bin, args, { maxBuffer: 50 * 1024 * 1024 });
    return { ok: true, stderr };
  } catch (e) {
    throw new Error(
      `${label} 失败：\n    ${String(e.stderr ?? e.message).split('\n').slice(-12).join('\n    ')}`
    );
  }
}

async function main() {
  const args = parseArgs(process.argv);

  // ---- 确认 ffmpeg 可用 ----
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

  // ---- 收集素材，按 shots.json 顺序 ----
  const clips = [];
  const missing = [];

  for (const shot of data.shots) {
    const rec = ledger.get(shot.id);
    let file = rec?.outputPath;

    // 台账没记就按约定路径找
    if (!file || !existsSync(file)) {
      const guess = resolve(paths.input, `${shot.id}.mp4`);
      file = existsSync(guess) ? guess : null;
    }

    if (!file) {
      missing.push(shot.id);
    } else {
      clips.push({ shot, file });
    }
  }

  if (missing.length) {
    log.error(`缺少 ${missing.length} 个镜头的素材：${missing.join(', ')}`);
    log.plain('');
    log.plain('  请先生成：npm run video');
    log.plain('  已有未完成任务的话先续传：npm run status');
    process.exitCode = 1;
    return;
  }

  // ---- 探测每段规格。concat 要求规格一致，不一致就得重编码。 ----
  log.info(`检查 ${clips.length} 段素材…`);
  const specs = [];
  for (const c of clips) {
    const info = await probe(c.file);
    specs.push(info);
    log.plain(`      ${c.shot.id}  ${describeVideo(info)}`);
  }

  const first = specs[0];
  const mismatched = specs.filter(
    (s) =>
      s.width !== first.width ||
      s.height !== first.height ||
      s.videoCodec !== first.videoCodec ||
      s.hasAudio !== first.hasAudio
  );

  const anyAudio = specs.some((s) => s.hasAudio);
  const allAudio = specs.every((s) => s.hasAudio);

  let needReencode = args.reencode || mismatched.length > 0;

  if (mismatched.length) {
    log.plain('');
    log.warn('各段规格不一致，将重新编码以保证拼接正确（慢一些但可靠）。');
  }
  if (anyAudio && !allAudio && !args.mute) {
    log.warn('部分素材有音轨、部分没有，拼接时会统一处理。');
    needReencode = true;
  }

  const totalDuration = specs.reduce((a, s) => a + (s.durationSec ?? 0), 0);

  log.plain('');
  log.plain(`  合计时长：${totalDuration.toFixed(2)} 秒`);
  log.plain(`  输出规格：${first.width}x${first.height}`);
  log.plain(`  编码方式：${needReencode ? '重新编码' : '直接拼接（不重编码，快）'}`);
  log.plain(`  音频处理：${args.mute ? '丢弃全部音轨（静音，音乐音效留到第 7 步）' : anyAudio ? '保留原始音轨' : '素材本身无音轨'}`);

  // ---- 拼接 ----
  if (!existsSync(paths.work)) mkdirSync(paths.work, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const listPath = resolve(paths.work, `concat-${stamp}.txt`);
  writeConcatList(listPath, clips.map((c) => c.file));

  const outPath = uniquePath(resolve(paths.work, `rough-cut-${stamp}.mp4`));

  log.plain('');
  log.info('拼接中…');

  const ffArgs = ['-y', '-f', 'concat', '-safe', '0', '-i', listPath];

  if (needReencode) {
    ffArgs.push(
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-vf', `scale=${first.width}:${first.height}:force_original_aspect_ratio=decrease,pad=${first.width}:${first.height}:(ow-iw)/2:(oh-ih)/2`
    );
    if (args.mute || !anyAudio) ffArgs.push('-an');
    else ffArgs.push('-c:a', 'aac', '-b:a', '192k');
  } else {
    // -an 可以和 -c copy 同时用：视频流逐字节复制，音频流只是不映射进去。
    // 所以静音拼接依然是无损的，不会重编码。
    ffArgs.push('-c', 'copy');
    if (args.mute) ffArgs.push('-an');
  }

  ffArgs.push('-movflags', '+faststart', outPath);

  await run('ffmpeg', ffArgs, '拼接');

  // ---- 校验成品 ----
  const outInfo = await probe(outPath);

  log.plain('');
  log.plain('═'.repeat(64));
  log.ok(`粗剪完成：${outPath.replace(projectDir, '.')}`);
  log.plain(`  ${describeVideo(outInfo)}  ${humanSize(fileSize(outPath) ?? 0)}`);

  const drift = Math.abs((outInfo.durationSec ?? 0) - totalDuration);
  if (drift > 0.5) {
    log.plain('');
    log.warn(
      `成品时长 ${outInfo.durationSec?.toFixed(2)} 秒与各段之和 ${totalDuration.toFixed(2)} 秒` +
        `相差 ${drift.toFixed(2)} 秒，建议用 --reencode 重跑。`
    );
  }

  log.plain('');
  log.plain('  这是粗剪，放在 work/ 里，不是最终成片。');
  log.plain('  下一步：加字幕、转场、音乐音效，然后出预览。');
  log.plain('═'.repeat(64));
  log.plain('');
}

main().catch((e) => {
  log.error(e?.message ?? String(e));
  process.exitCode = 1;
});
