#!/usr/bin/env node
/**
 * 报价命令。npm run quote [-- 项目名] [--force]
 *
 * 零花费。读 shots.json、校验参数、查台账、算钱、打明细，然后停下。
 * 不发任何 HTTP 请求。
 */

import { loadConfig } from './config.js';
import { log, registerSecrets } from './logger.js';
import { resolveProject, loadShots, projectPaths } from './project.js';
import { Ledger, planSubmission } from './jobs.js';
import { quoteBatch, renderQuote, fmt } from './pricing.js';
import { ValidationError } from './validate.js';

function parseArgs(argv) {
  const args = { project: null, force: false };
  for (const a of argv.slice(2)) {
    if (a === '--force') args.force = true;
    else if (!a.startsWith('--')) args.project = a;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  let config;
  try {
    // 报价不需要密钥，允许 .env 还没填就先看价
    config = loadConfig({ requireKey: false });
  } catch (e) {
    log.error(e.message);
    process.exitCode = 1;
    return;
  }
  registerSecrets([config.apiKey, config.lk888Key]);

  let projectDir, data;
  try {
    projectDir = resolveProject(args.project);
    data = loadShots(projectDir);
  } catch (e) {
    log.error(e instanceof ValidationError ? `分镜校验失败：${e.message}` : e.message);
    process.exitCode = 1;
    return;
  }

  const paths = projectPaths(projectDir);

  log.plain('');
  log.plain(`项目：${data.meta.title ?? '(无标题)'}  [${data.meta.project ?? projectDir}]`);
  log.plain(`画幅：${data.meta.aspect ?? '?'} ${data.meta.orientation}`);
  log.plain(`分镜：${paths.shotsFile}`);
  log.plain('');

  if (data.warnings.length) {
    for (const w of data.warnings) log.warn(w);
    log.plain('');
  }

  // 台账
  let ledger;
  try {
    ledger = new Ledger(projectDir);
  } catch (e) {
    log.error(e.message);
    process.exitCode = 1;
    return;
  }

  const plan = planSubmission(data.shots, ledger, { force: args.force });

  if (plan.blocked.length) {
    log.plain('以下镜头被台账拦住，不能提交：');
    for (const b of plan.blocked) log.plain(`  ✖ ${b.message}`);
    log.plain('');
  }
  if (plan.skipped.length) {
    log.plain('以下镜头将被跳过：');
    for (const s of plan.skipped) log.plain(`  – ${s.message}`);
    log.plain('');
  }

  // 参考图：统计还缺几张公网 URL
  const refs = data.referenceImages;
  const refsNeedingGeneration = refs.filter((r) => !r.url);
  const shotsMissingRefs = plan.toSubmit.filter(
    ({ shot }) => shot.referenceImages.length === 0
  );

  if (refsNeedingGeneration.length) {
    log.plain(`参考图：${refs.length} 张中有 ${refsNeedingGeneration.length} 张还没有公网 URL，需要先生成。`);
    for (const r of refsNeedingGeneration) {
      log.plain(`  · ${r.id}（${r.role}）`);
    }
    log.plain('');
  }

  if (plan.toSubmit.length === 0) {
    log.plain('没有需要提交的镜头。');
    if (ledger.all().length) {
      const s = ledger.summary();
      log.plain('');
      log.plain(`台账：共 ${s.total} 条，累计花费 ${fmt(s.totalSpentCny)}`);
      log.plain(`      ${JSON.stringify(s.byStatus)}`);
    }
    return;
  }

  const quote = quoteBatch(
    {
      images: refsNeedingGeneration.length,
      shots: plan.toSubmit.map((t) => t.shot),
    },
    config
  );

  log.plain(renderQuote(quote, config));
  log.plain('');

  // 镜头本身不必填 reference_images —— 提交时会统一带上项目级的三张参考图。
  // 只有当项目级参考图也缺 URL 时才需要提醒。
  const readyRefs = refs.filter((r) => r.url);
  if (refsNeedingGeneration.length > 0) {
    log.warn(
      `还有 ${refsNeedingGeneration.length} 张参考图没有 URL，` +
        `提交视频前请先运行 npm run refs。`
    );
    log.plain('');
  } else if (readyRefs.length > 0) {
    log.plain(`参考图就绪：${readyRefs.length} 张，提交时会自动带给每个镜头。`);
    log.plain('');
  }

  log.plain('这是报价命令，不会提交任何任务，未产生费用。');
  log.plain('');

  const s = ledger.summary();
  if (s.total) {
    log.plain(`台账现状：共 ${s.total} 条，累计已花 ${fmt(s.totalSpentCny)}，${JSON.stringify(s.byStatus)}`);
    log.plain('');
  }
}

main().catch((e) => {
  log.error(`未预期的错误：${e?.message ?? e}`);
  process.exitCode = 1;
});
