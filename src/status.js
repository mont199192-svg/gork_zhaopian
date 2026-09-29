#!/usr/bin/env node
/**
 * 任务状态查询与续传。npm run status [-- 项目]
 *
 * 零花费。只做 GET 查询和下载。
 *
 * 用途：
 *   1. 看台账全貌（哪些成了、哪些败了、花了多少）
 *   2. 续传中断的任务 —— 轮询被 Ctrl+C 打断、或下载失败时，
 *      task_id 还在台账里，用这个命令接着查、接着下，不重新生成。
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

import { loadConfig } from './config.js';
import { log, registerSecrets } from './logger.js';
import { resolveProject, loadShots, projectPaths } from './project.js';
import { Ledger } from './jobs.js';
import { fmt } from './pricing.js';
import { pollUntilDone } from './poll.js';
import { downloadPublic, humanSize } from './download.js';
import { verifyVideo, describeVideo } from './ffprobe.js';

function parseArgs(argv) {
  const args = { project: null, timeout: null, noResume: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--no-resume') args.noResume = true;
    else if (a === '--timeout') args.timeout = Number(rest[++i]);
    else if (!a.startsWith('--')) args.project = a;
  }
  return args;
}

const STATUS_ICON = {
  success: '✓',
  failed: '✖',
  pending: '…',
  submitting: '?',
};

async function resumeOne(rec, ctx) {
  const { config, ledger, paths, shotMap, timeoutMinutes } = ctx;
  const id = rec.id;

  log.plain('');
  log.info(`续传 ${id}（task_id=${rec.taskId}）`);

  const result = await pollUntilDone(config, rec.taskId, {
    logger: log,
    timeoutMinutes: timeoutMinutes ?? config.videoTimeoutMinutes,
    provider: 'lk888',
  });

  if (result.outcome === 'failure') {
    // lk888 失败自动退款，记 0 元
    ledger.markFailed(id, result.error, { charged: false });
    log.error(`任务失败：${result.error}`);
    log.plain('      lk888 对失败任务自动退款，本次记 0 元。');
    return { id, outcome: 'failure' };
  }

  if (result.outcome === 'timeout') {
    log.warn(result.error);
    return { id, outcome: 'timeout' };
  }

  log.ok('任务已完成，开始下载');

  // lk888 没有 /content 端点，只能走 result_url
  const target = resolve(paths.input, `${id}.mp4`);
  if (!result.videoUrl) {
    log.error('任务已成功但响应里没有 result_url，无法下载。台账保留 pending。');
    return { id, outcome: 'download_failed' };
  }

  let dl;
  try {
    dl = await downloadPublic(result.videoUrl, target, { logger: log });
  } catch (err) {
    log.error(`下载失败：${err.message}`);
    log.plain('      任务已生成且已扣费，素材仍在服务端。稍后可再跑一次 npm run status 重试下载。');
    return { id, outcome: 'download_failed' };
  }

  log.ok(`已下载：${dl.path.replace(paths.root, '.')}（${humanSize(dl.bytes)}）`);
  if (dl.renamed) log.warn('目标文件已存在，已改名保存，未覆盖原文件。');

  const shot = shotMap.get(id);
  let verified = true;
  if (shot) {
    // 尺寸由平台按 aspect_ratio + resolution 决定，不是精确像素串，只校验时长
    const check = await verifyVideo(dl.path, { seconds: shot.seconds });
    if (check.info) log.plain(`      ${describeVideo(check.info)}`);
    verified = check.ok;
    if (!check.ok) {
      log.warn('文件校验发现问题：');
      for (const p of check.problems) log.plain(`        · ${p}`);
    }
  }

  ledger.markSuccess(id, { outputPath: dl.path, actualCny: rec.estimatedCny ?? 0 });
  return { id, outcome: 'success', verified };
}

async function main() {
  const args = parseArgs(process.argv);

  let config;
  try {
    // 续传要查 lk888 的任务状态，所以这条命令也需要 lk888 的 key
    config = loadConfig({ requireLk888Key: true });
  } catch (e) {
    log.error(e.message);
    process.exitCode = 1;
    return;
  }
  registerSecrets([config.apiKey, config.lk888Key]);

  let projectDir, paths, shotMap = new Map();
  try {
    projectDir = resolveProject(args.project);
    paths = projectPaths(projectDir);
    try {
      const data = loadShots(projectDir);
      for (const s of data.shots) shotMap.set(s.id, s);
    } catch {
      // 分镜文件读不了不影响查状态
    }
  } catch (e) {
    log.error(e.message);
    process.exitCode = 1;
    return;
  }

  const ledger = new Ledger(projectDir);
  const all = ledger.all();

  log.plain('');
  log.plain(`项目：${projectDir}`);
  log.plain('─'.repeat(64));

  if (all.length === 0) {
    log.plain('  台账为空，还没有提交过任何任务。');
    log.plain('');
    return;
  }

  // ---- 台账全貌 ----
  for (const j of all) {
    const icon = STATUS_ICON[j.status] ?? '·';
    const cost = j.actualCny !== undefined && j.actualCny !== null ? fmt(j.actualCny) : '-';
    log.plain(`  ${icon} ${j.id.padEnd(22)} ${j.status.padEnd(11)} ${cost.padStart(9)}`);

    if (j.status === 'success' && j.outputPath) {
      const exists = existsSync(j.outputPath);
      log.plain(`      ${exists ? '文件在' : '⚠ 文件已不在'}：${j.outputPath.replace(projectDir, '.')}`);
    }
    if (j.status === 'failed' && j.error) {
      log.plain(`      原因：${String(j.error).split('\n')[0].slice(0, 100)}`);
    }
    if (j.taskId && j.status === 'pending') {
      log.plain(`      task_id：${j.taskId}`);
    }
  }

  const s = ledger.summary();
  log.plain('─'.repeat(64));
  log.plain(`  共 ${s.total} 条 · ${JSON.stringify(s.byStatus)} · 累计 ${fmt(s.totalSpentCny)}`);
  if (s.historyCount) log.plain(`  历史归档 ${s.historyCount} 条`);
  log.plain('');

  // ---- 找出可续传的任务 ----
  const resumable = all.filter(
    (j) => j.taskId && j.status === 'pending' && !String(j.taskId).startsWith('sync-')
  );

  const stuck = all.filter((j) => j.status === 'submitting' && !j.taskId);
  if (stuck.length) {
    log.warn(`有 ${stuck.length} 条记录停在 submitting 且没有 task_id：`);
    for (const j of stuck) log.plain(`      ${j.id}`);
    log.plain('');
    log.plain('  这意味着上次提交后结果未知（可能网络中断）。');
    log.plain('  请到 lk888 后台任务列表确认这些任务是否真的创建了，');
    log.plain('  再决定是否用 --force 重新提交 —— 直接重提可能重复扣费。');
    log.plain('');
  }

  if (resumable.length === 0) {
    if (!stuck.length) log.plain('  没有需要续传的任务。');
    log.plain('');
    return;
  }

  if (args.noResume) {
    log.plain(`  有 ${resumable.length} 条可续传（--no-resume 已跳过）。`);
    log.plain('');
    return;
  }

  log.plain(`  发现 ${resumable.length} 条未完成任务，开始续传（查询和下载不花钱）…`);

  const results = [];
  for (const rec of resumable) {
    results.push(await resumeOne(rec, { config, ledger, paths, shotMap, timeoutMinutes: args.timeout }));
  }

  log.plain('');
  log.plain('═'.repeat(64));
  const okCount = results.filter((r) => r.outcome === 'success').length;
  log.plain(`  续传完成：成功 ${okCount}/${results.length}`);
  log.plain(`  累计花费：${fmt(ledger.totalSpent())}（续传本身不产生新费用）`);
  log.plain('═'.repeat(64));
  log.plain('');
}

main().catch((e) => {
  log.error(`未预期的错误：${e?.message ?? e}`);
  process.exitCode = 1;
});
