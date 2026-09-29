#!/usr/bin/env node
/**
 * 对账更正。node src/correct.js <项目> <jobId> <实际金额>
 *
 * 用于把台账里估算的扣费改成心流使用日志里的真实金额。
 * 零花费，只改本地文件。
 */

import { log } from './logger.js';
import { resolveProject } from './project.js';
import { Ledger } from './jobs.js';
import { fmt } from './pricing.js';

const rawArgs = process.argv.slice(2);

// --archived N：改 history 里的第 N 条归档记录，而不是当前记录。
// 重提过的 jobId，上一次的金额已经归档，对账时要点名改它。
let archivedIndex = null;
const archIdx = rawArgs.indexOf('--archived');
if (archIdx !== -1) {
  archivedIndex = Number(rawArgs[archIdx + 1]);
  rawArgs.splice(archIdx, 2);
}
const listMode = rawArgs.includes('--list');
if (listMode) rawArgs.splice(rawArgs.indexOf('--list'), 1);

const [projectArg, jobId, amountArg] = rawArgs;

if (listMode) {
  // 列出某个 jobId 的所有记录（当前 + 归档），带上可直接复制的更正命令
  const dir = resolveProject(projectArg);
  const ledger = new Ledger(dir);
  const cur = jobId ? ledger.get(jobId) : null;
  const arch = (ledger.data.history ?? []).filter((h) => !jobId || h.id === jobId);

  log.plain('');
  log.plain(`累计记账：${fmt(ledger.totalSpent())}`);
  log.plain('');
  if (cur) {
    log.plain('当前记录：');
    log.plain(
      `  ${cur.id}  ${cur.status}  记账 ${fmt(cur.actualCny ?? 0)}  ` +
        `参考图 ${cur.referenceImages?.length ?? 0} 张  ${cur.submittedAt ?? ''}`
    );
    log.plain(`    更正：node src/correct.js ${projectArg} ${cur.id} <实际金额>`);
  }
  if (arch.length) {
    log.plain('');
    log.plain('归档记录（--archived N 里的 N 就是下面的序号）：');
    arch.forEach((h, i) => {
      log.plain(
        `  [${i}] ${h.id}  ${h.status}  记账 ${fmt(h.actualCny ?? 0)}  ` +
          `参考图 ${h.referenceImages?.length ?? 0} 张  ${h.submittedAt ?? ''}`
      );
      if (h.taskId) log.plain(`       task_id ${h.taskId}`);
      log.plain(`       更正：node src/correct.js ${projectArg} ${h.id} <实际金额> --archived ${i}`);
    });
  }
  log.plain('');
} else if (!jobId || amountArg === undefined) {
  log.plain('');
  log.plain('用法：node src/correct.js <项目> <jobId> <实际金额> [--archived N]');
  log.plain('     node src/correct.js <项目> [jobId] --list');
  log.plain('');
  log.plain('示例：node src/correct.js 001 ref:ref-character 0');
  log.plain('     node src/correct.js 001 shot-01 0.48 --archived 4');
  log.plain('     node src/correct.js 001 shot-01 --list');
  log.plain('');
  process.exitCode = 1;
} else {
  const amount = Number(amountArg);
  if (!Number.isFinite(amount) || amount < 0) {
    log.error(`金额不合法：${amountArg}`);
    process.exitCode = 1;
  } else {
    const dir = resolveProject(projectArg);
    const ledger = new Ledger(dir);
    const before =
      archivedIndex === null
        ? ledger.get(jobId)
        : (ledger.data.history ?? []).filter((h) => h.id === jobId)[archivedIndex];

    if (!before) {
      if (archivedIndex === null) {
        log.error(`台账里没有 ${jobId}。现有记录：${ledger.all().map((j) => j.id).join(', ') || '无'}`);
        log.plain('  若要改的是重提前的旧记录，先跑：node src/correct.js <项目> ' + jobId + ' --list');
      } else {
        log.error(`${jobId} 没有第 ${archivedIndex} 条归档记录。`);
        log.plain(`  先跑：node src/correct.js ${projectArg} ${jobId} --list`);
      }
      process.exitCode = 1;
    } else {
      const oldAmount = before.actualCny ?? 0;
      const oldTotal = ledger.totalSpent();
      ledger.correctCharge(jobId, amount, { archivedIndex });

      log.plain('');
      log.ok(`已更正 ${jobId}${archivedIndex === null ? '' : ` （归档第 ${archivedIndex} 条）`}`);
      log.plain(`  该条：${fmt(oldAmount)} → ${fmt(amount)}`);
      log.plain(`  累计：${fmt(oldTotal)} → ${fmt(ledger.totalSpent())}`);
      log.plain('');
    }
  }
}
