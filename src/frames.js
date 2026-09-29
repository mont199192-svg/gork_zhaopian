#!/usr/bin/env node
/**
 * 第 9 步：抽关键帧供检查。npm run frames [-- 项目]
 *
 * 零花费，纯本地。
 *
 * 按镜头抽帧，而不是全片均匀抽 —— 因为要检查的是「每个镜头有没有崩」，
 * 均匀抽帧会让长镜头抽得多、短镜头抽得少，反而漏掉短镜头的问题。
 * 每个镜头默认抽 3 帧（首、中、尾），文件名带镜头 id 和时间点。
 *
 * 抽的是合成版（带字幕转场）里的画面，因为那才是你最终会看到的东西。
 * 输出到 preview/frames-<时间戳>/。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

import { log } from './logger.js';
import { resolveProject, loadShots, projectPaths } from './project.js';
import { Ledger } from './jobs.js';
import { probe, describeVideo, checkFfmpeg } from './ffprobe.js';
import { humanSize, fileSize } from './download.js';
import { resolveSource } from './pickLatest.js';
import { computeOffsets } from './compose.js';

const exec = promisify(execFile);

function parseArgs(argv) {
  const args = { project: null, source: null, perShot: 3, transitionSec: 0.5 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') args.source = argv[++i];
    else if (a === '--per-shot') args.perShot = Number(argv[++i]);
    else if (a === '--transition-sec') args.transitionSec = Number(argv[++i]);
    else if (a === '--') continue;
    else if (!a.startsWith('--')) args.project = a;
    else throw new Error(`不认识的参数 "${a}"。`);
  }
  if (!Number.isInteger(args.perShot) || args.perShot < 1 || args.perShot > 20) {
    throw new Error(`--per-shot 必须是 1 到 20 之间的整数，收到 ${args.perShot}。`);
  }
  return args;
}

/**
 * 在一个镜头内挑抽帧时间点。
 * 避开首尾各 0.15 秒 —— 转场交叠处的画面是两个镜头混在一起的，
 * 抽到那里没法判断是哪个镜头的问题。
 */
function pickTimes(startSec, durationSec, count) {
  const pad = Math.min(0.15, durationSec / 10);
  const a = startSec + pad;
  const b = startSec + durationSec - pad;
  if (count === 1) return [(a + b) / 2];
  const step = (b - a) / (count - 1);
  return Array.from({ length: count }, (_, i) => a + step * i);
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

  let projectDir, data, paths, src;
  try {
    projectDir = resolveProject(args.project);
    data = loadShots(projectDir);
    paths = projectPaths(projectDir);
    src = resolveSource(args.source, { work: paths.work, root: projectDir });
  } catch (e) {
    log.error(e.message);
    process.exitCode = 1;
    return;
  }

  const info = await probe(src.path);
  const ledger = new Ledger(projectDir);

  log.plain('');
  log.plain(`源文件：${basename(src.path)}  （${src.why}）`);
  log.plain(`  ${describeVideo(info)}`);

  // ---- 还原镜头在成片里的时间位置 ----
  // 用各段素材的真实时长重算，而不是信 shots.json 里申报的秒数，
  // 因为模型给的时长总是差一点（申报 8 秒实际 8.04 秒），累积起来会偏。
  const clips = [];
  for (const shot of data.shots) {
    const rec = ledger.get(shot.id);
    let file = rec?.outputPath;
    if (!file || !existsSync(file)) {
      const guess = resolve(paths.input, `${shot.id}.mp4`);
      file = existsSync(guess) ? guess : null;
    }
    if (!file) continue;
    const ci = await probe(file);
    clips.push({ shot, durationSec: ci.durationSec ?? 0 });
  }

  if (clips.length === 0) {
    log.error('找不到任何镜头素材，没法按镜头定位。');
    process.exitCode = 1;
    return;
  }

  // 成片是硬切还是带转场，决定了时间轴怎么算。
  // 用实际时长反推：比各段之和短多少，就是被转场吃掉的。
  const sumDur = clips.reduce((a, c) => a + c.durationSec, 0);
  const actual = info.durationSec ?? sumDur;
  const gapCount = clips.length - 1;
  let tSec = 0;
  if (gapCount > 0) {
    const shrink = sumDur - actual;
    // 容忍 0.2 秒的编码误差；超过就认为用了转场
    if (shrink > 0.2) {
      tSec = shrink / gapCount;
      log.plain(`  检测到转场：每处约 ${tSec.toFixed(2)} 秒（成片比素材之和短 ${shrink.toFixed(2)} 秒）`);
    } else {
      log.plain('  检测到硬切：没有转场重叠');
    }
  }

  const { offsets } = computeOffsets(clips, tSec);

  // ---- 抽帧 ----
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = resolve(paths.preview, `frames-${stamp}`);
  mkdirSync(outDir, { recursive: true });

  log.plain('');
  log.info(`每个镜头抽 ${args.perShot} 帧，共 ${clips.length * args.perShot} 张…`);

  const written = [];
  for (const c of clips) {
    const off = offsets.get(c.shot.id);
    const times = pickTimes(off.startSec, off.durationSec, args.perShot);

    for (const [i, t] of times.entries()) {
      const name = `${c.shot.id}-${String(i + 1).padStart(2, '0')}-${t.toFixed(2)}s.png`;
      const outFile = resolve(outDir, name);

      // -ss 放在 -i 前面是快速定位（关键帧对齐），放后面是精确定位但慢。
      // 抽帧要准，所以用「-ss 在前粗定位 + 在后精定位」的组合写法。
      const coarse = Math.max(0, t - 2);
      const fine = t - coarse;

      try {
        await exec(
          'ffmpeg',
          [
            '-y', '-hide_banner', '-v', 'error',
            '-ss', coarse.toFixed(3),
            '-i', src.path,
            '-ss', fine.toFixed(3),
            '-frames:v', '1',
            '-q:v', '2',
            outFile,
          ],
          { maxBuffer: 20 * 1024 * 1024 }
        );
        if (existsSync(outFile)) written.push({ name, shot: c.shot.id, t });
      } catch (e) {
        log.warn(`${name} 抽帧失败：${String(e.stderr ?? e.message).split('\n').slice(-2).join(' ')}`);
      }
    }
    log.plain(`      ${c.shot.id}  ${off.startSec.toFixed(2)}s → ${(off.startSec + off.durationSec).toFixed(2)}s  已抽 ${times.length} 张`);
  }

  const totalBytes = written.reduce((a, w) => a + (fileSize(resolve(outDir, w.name)) ?? 0), 0);

  log.plain('');
  log.plain('═'.repeat(64));
  log.ok(`抽帧完成：${outDir.replace(projectDir, '.')}`);
  log.plain(`  ${written.length} 张  ${humanSize(totalBytes)}`);

  log.plain('');
  log.plain('  接下来请打开这个目录逐张看，重点检查：');
  log.plain('    · 人物长相在三个镜头之间是否一致');
  log.plain('    · 有没有多余的肢体、扭曲的手、崩坏的脸');
  log.plain('    · 字幕位置有没有挡住关键画面、有没有出框');
  log.plain('    · 窗外场景、光线方向在镜头之间是否连贯');
  log.plain('');
  log.plain('  剪辑层面的问题（字幕、时长、转场）我改配置就能修，零费用。');
  log.plain('  画面本身的问题要重新生成镜头，那会重新计费，我会先报价等你确认。');
  log.plain('');
}

export { parseArgs, pickTimes };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    log.error(e.message);
    process.exitCode = 1;
  });
}
