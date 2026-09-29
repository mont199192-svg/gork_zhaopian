#!/usr/bin/env node
/**
 * 第 10 步：导出最终成片。npm run export [-- 项目]
 *
 * 零花费，纯本地。
 *
 * 交付规格 720p —— 素材本身就是 1280x720（gk-video-3.5 的上限），
 * 放大到 1080p 只会让画面发虚，不会增加细节，所以默认不放大。
 * 真要放大：--upscale 1080，脚本会照做但会先警告。
 *
 * 默认视频流直接复制（-c copy），不重新编码：
 * 合成版已经是最终画质，再编一次只会掉质量。
 *
 * 输出到 outputs/，用 uniquePath 保证不覆盖任何已有成片。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

import { log } from './logger.js';
import { resolveProject, loadShots, projectPaths } from './project.js';
import { Ledger } from './jobs.js';
import { probe, describeVideo, checkFfmpeg } from './ffprobe.js';
import { uniquePath, humanSize, fileSize } from './download.js';
import { resolveSource } from './pickLatest.js';

const exec = promisify(execFile);

function parseArgs(argv) {
  const args = { project: null, source: null, name: null, upscale: null, crf: 18 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') args.source = argv[++i];
    else if (a === '--name') args.name = argv[++i];
    else if (a === '--upscale') args.upscale = Number(argv[++i]);
    else if (a === '--crf') args.crf = Number(argv[++i]);
    else if (a === '--') continue;
    else if (!a.startsWith('--')) args.project = a;
    else throw new Error(`不认识的参数 "${a}"。`);
  }
  if (args.upscale !== null && ![1080, 1440, 2160].includes(args.upscale)) {
    throw new Error(`--upscale 只支持 1080 / 1440 / 2160，收到 ${args.upscale}。`);
  }
  if (!Number.isFinite(args.crf) || args.crf < 0 || args.crf > 51) {
    throw new Error(`--crf 必须在 0 到 51 之间，收到 ${args.crf}。`);
  }
  return args;
}

/** 文件名用的安全片名：去掉路径分隔符和 Windows 不允许的字符。 */
function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 60) || 'final';
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
    // 成片只从合成版导。粗剪没有字幕和转场，不该当成品交付。
    src = resolveSource(args.source, { work: paths.work, root: projectDir }, ['composed-']);
  } catch (e) {
    log.error(e.message);
    if (!args.source && /没有可用的视频/.test(e.message)) {
      log.plain('');
      log.plain('  成片要从合成版导出（带字幕和转场）。先跑：npm run compose');
      log.plain('  真要拿粗剪交付的话：npm run export -- --source work/rough-cut-xxx.mp4');
    }
    process.exitCode = 1;
    return;
  }

  const info = await probe(src.path);

  log.plain('');
  log.plain(`项目：${data.meta.title ?? projectDir}`);
  log.plain('─'.repeat(64));
  log.plain(`源文件：${basename(src.path)}  （${src.why}）`);
  log.plain(`  ${describeVideo(info)}  ${humanSize(fileSize(src.path) ?? 0)}`);

  // ---- 交付前的例行检查 ----
  const issues = [];
  if (!info.hasAudio) issues.push('没有音轨（配乐和音效还没铺）');
  if ((info.durationSec ?? 0) < 3) issues.push(`时长只有 ${info.durationSec?.toFixed(2)} 秒`);
  if (info.height && info.height < 720) issues.push(`分辨率只有 ${info.width}x${info.height}`);

  if (issues.length) {
    log.plain('');
    for (const i of issues) log.warn(i);
  }

  const reencode = args.upscale !== null;
  if (reencode) {
    log.plain('');
    log.warn(
      `要放大到 ${args.upscale}p。素材原始高度是 ${info.height}px，` +
        '放大不会增加细节，只会让画面变软，并且需要重新编码。'
    );
  }

  if (!existsSync(paths.outputs)) mkdirSync(paths.outputs, { recursive: true });

  const title = safeName(args.name ?? data.meta.title ?? basename(projectDir));
  const targetH = args.upscale ?? info.height ?? 720;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 10);
  const outPath = uniquePath(resolve(paths.outputs, `${title}-${targetH}p-${stamp}.mp4`));

  const ffArgs = ['-y', '-hide_banner', '-i', src.path];

  if (reencode) {
    ffArgs.push(
      '-vf', `scale=-2:${args.upscale}:flags=lanczos`,
      '-c:v', 'libx264',
      '-preset', 'slow',
      '-crf', String(args.crf),
      '-pix_fmt', 'yuv420p'
    );
  } else {
    // 视频流逐字节复制：成片和合成版画质完全一致，没有二次损失
    ffArgs.push('-c:v', 'copy');
  }

  if (info.hasAudio) ffArgs.push('-c:a', 'aac', '-b:a', '192k');
  else ffArgs.push('-an');

  ffArgs.push('-movflags', '+faststart', outPath);

  log.plain('');
  log.info(reencode ? `放大到 ${args.upscale}p 并重新编码…` : '导出中（视频流直接复制，无损）…');

  try {
    await exec('ffmpeg', ffArgs, { maxBuffer: 50 * 1024 * 1024 });
  } catch (e) {
    log.error(`导出失败：\n    ${String(e.stderr ?? e.message).split('\n').slice(-12).join('\n    ')}`);
    process.exitCode = 1;
    return;
  }

  const outInfo = await probe(outPath);

  // ---- 交付清单 ----
  const ledger = new Ledger(projectDir);
  const spent = ledger.totalSpent();

  const manifest = {
    title: data.meta.title ?? null,
    exportedAt: new Date().toISOString(),
    source: basename(src.path),
    output: basename(outPath),
    resolution: `${outInfo.width}x${outInfo.height}`,
    durationSec: outInfo.durationSec,
    fps: outInfo.fps,
    videoCodec: outInfo.videoCodec,
    audioCodec: outInfo.audioCodec ?? null,
    bytes: fileSize(outPath),
    upscaled: reencode ? `${info.height}p → ${args.upscale}p` : false,
    shots: data.shots.map((s) => ({ id: s.id, seconds: s.seconds, resolution: s.resolution })),
    totalSpentCny: spent,
  };
  const manifestPath = uniquePath(resolve(paths.outputs, `${basename(outPath, '.mp4')}.json`));
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  log.plain('');
  log.plain('═'.repeat(64));
  log.ok(`成片已导出：${outPath.replace(projectDir, '.')}`);
  log.plain(`  ${describeVideo(outInfo)}  ${humanSize(fileSize(outPath) ?? 0)}`);
  log.plain(`  清单：${manifestPath.replace(projectDir, '.')}`);
  log.plain(`  本片累计花费：¥${Number(spent).toFixed(4)}`);
  log.plain('');
  log.plain('  成片在 outputs/ 里，不会被后续操作覆盖。');
  log.plain('');
}

export { parseArgs, safeName };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    log.error(e.message);
    process.exitCode = 1;
  });
}
