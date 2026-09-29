#!/usr/bin/env node
/**
 * 第 8 步：输出低分辨率预览。npm run preview [-- 项目]
 *
 * 零花费，纯本地。
 *
 * 目的是给你一个小文件快速过一遍整体节奏，不是看画质。
 * 默认 640x360，码率压低，20 秒的片子通常一两兆。
 *
 * 输出到 preview/，和 work/ 里的合成版、outputs/ 里的成片都分开放。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

import { log } from './logger.js';
import { resolveProject, projectPaths } from './project.js';
import { probe, describeVideo, checkFfmpeg } from './ffprobe.js';
import { uniquePath, humanSize, fileSize } from './download.js';
import { resolveSource } from './pickLatest.js';

const exec = promisify(execFile);

function parseArgs(argv) {
  const args = { project: null, source: null, height: 360, crf: 30 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') args.source = argv[++i];
    else if (a === '--height') args.height = Number(argv[++i]);
    else if (a === '--crf') args.crf = Number(argv[++i]);
    else if (a === '--') continue;
    else if (!a.startsWith('--')) args.project = a;
    else throw new Error(`不认识的参数 "${a}"。`);
  }
  if (!Number.isFinite(args.height) || args.height < 120 || args.height > 1080) {
    throw new Error(`--height 必须在 120 到 1080 之间，收到 ${args.height}。`);
  }
  if (!Number.isFinite(args.crf) || args.crf < 0 || args.crf > 51) {
    throw new Error(`--crf 必须在 0 到 51 之间，收到 ${args.crf}。`);
  }
  return args;
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

  let projectDir, paths, src;
  try {
    projectDir = resolveProject(args.project);
    paths = projectPaths(projectDir);
    src = resolveSource(args.source, { work: paths.work, root: projectDir });
  } catch (e) {
    log.error(e.message);
    process.exitCode = 1;
    return;
  }

  const info = await probe(src.path);

  log.plain('');
  log.plain(`源文件：${basename(src.path)}  （${src.why}）`);
  log.plain(`  ${describeVideo(info)}  ${humanSize(fileSize(src.path) ?? 0)}`);

  if (!info.hasAudio) {
    log.plain('');
    log.warn('源文件没有音轨。预览也会是静音的。');
  }

  if (!existsSync(paths.preview)) mkdirSync(paths.preview, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = uniquePath(resolve(paths.preview, `preview-${stamp}.mp4`));

  // -2 让宽度自动配成偶数（h264 要求），同时保持原始宽高比
  const ffArgs = [
    '-y', '-hide_banner',
    '-i', src.path,
    '-vf', `scale=-2:${args.height}`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', String(args.crf),
    '-pix_fmt', 'yuv420p',
  ];

  if (info.hasAudio) ffArgs.push('-c:a', 'aac', '-b:a', '96k');
  else ffArgs.push('-an');

  ffArgs.push('-movflags', '+faststart', outPath);

  log.plain('');
  log.info(`压成 ${args.height}p 预览…`);

  try {
    const { stderr } = await exec('ffmpeg', ffArgs, { maxBuffer: 50 * 1024 * 1024 });
    void stderr;
  } catch (e) {
    log.error(`压制失败：\n    ${String(e.stderr ?? e.message).split('\n').slice(-12).join('\n    ')}`);
    process.exitCode = 1;
    return;
  }

  const outInfo = await probe(outPath);
  const srcBytes = fileSize(src.path) ?? 0;
  const outBytes = fileSize(outPath) ?? 0;

  log.plain('');
  log.plain('═'.repeat(64));
  log.ok(`预览完成：${outPath.replace(projectDir, '.')}`);
  log.plain(`  ${describeVideo(outInfo)}  ${humanSize(outBytes)}`);
  if (srcBytes > 0) {
    log.plain(`  体积压到原来的 ${Math.round((outBytes / srcBytes) * 100)}%`);
  }

  log.plain('');
  log.plain('  这是给你快速过节奏用的，画质不代表成片。');
  log.plain('  看完如果要逐帧检查：npm run frames');
  log.plain('  确认没问题就导出：npm run export');
  log.plain('');
}

export { parseArgs };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    log.error(e.message);
    process.exitCode = 1;
  });
}
