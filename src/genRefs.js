#!/usr/bin/env node
/**
 * 参考图生成。npm run refs [-- 项目名] [--only ref-character] [--force]
 *
 * ⚠ 收费命令。提交前报价并等待「确认生成」。
 *
 * 流程（每张图）：
 *   查台账 → 报价 → 等确认 → 台账落 submitting
 *   → POST /v1/chat/completions（零重试）
 *   → 解析 URL → 下载本地留档 → HEAD 确认 URL 可访问
 *   → URL 连同时间戳写回 shots.json → 台账标成功
 *
 * 失败即停。绝不自动重提。
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { loadConfig } from './config.js';
import { log, registerSecrets } from './logger.js';
import { resolveProject, loadShots, projectPaths } from './project.js';
import { Ledger } from './jobs.js';
import { quoteImages, quoteBatch, renderQuote, fmt } from './pricing.js';
import { gate, ConfirmationDeclined } from './confirm.js';
import { apiPost } from './http.js';
import { buildImagePayload, ENDPOINTS } from './fieldMap.js';
import { parseImageUrl, ImageUrlParseError } from './parseImageUrl.js';
import { downloadPublic, checkUrlAlive, humanSize, uniquePath } from './download.js';
import { describeCreateFailure, ApiError } from './errors.js';
import { resolve } from 'node:path';

function parseArgs(argv) {
  const args = { project: null, only: null, force: false, limit: null };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--force') args.force = true;
    else if (a === '--only') args.only = rest[++i];
    else if (a === '--limit') args.limit = Number(rest[++i]);
    else if (!a.startsWith('--')) args.project = a;
  }
  return args;
}

/**
 * 判断一次失败到底扣没扣钱。
 *   4xx 被上游拒绝 → 任务从未创建 → 没扣费
 *   5xx / 网络中断 → 不确定
 */
function chargeStatusOf(err) {
  if (err instanceof ApiError && typeof err.status === 'number') {
    if (err.status >= 400 && err.status < 500) return false; // 确定没扣
    return null; // 5xx 不确定
  }
  return null; // 网络异常不确定
}

/** 把生成好的 URL 写回 shots.json，保留缩进与其他字段。 */
function writeBackUrl(shotsFile, refId, url, localPath) {
  const raw = JSON.parse(readFileSync(shotsFile, 'utf8'));
  const target = (raw.referenceImages ?? []).find((r) => r.id === refId);
  if (!target) throw new Error(`shots.json 里找不到参考图 ${refId}`);
  target.url = url;
  target.urlFetchedAt = new Date().toISOString();
  target.localPath = localPath;
  writeFileSync(shotsFile, JSON.stringify(raw, null, 2) + '\n', 'utf8');
}

async function generateOne(ref, ctx) {
  const { config, ledger, paths, jobId } = ctx;

  log.plain('');
  log.info(`生成参考图 ${ref.id}（${ref.role}）…`);

  const estimated = quoteImages(1, config).totalCny;

  // 提交前落痕。必须在 HTTP 请求之前。
  ledger.markSubmitting(jobId, {
    model: config.imageModel,
    prompt: ref.prompt,
    estimatedCny: estimated,
  });

  // size 显式给，不让模型从提示词里猜画幅（猜错过一次，见 buildImagePayload 注释）
  const payload = buildImagePayload({
    model: config.imageModel,
    prompt: ref.prompt,
    size: ref.size ?? '1280x720',
  });

  let response;
  try {
    response = await apiPost(config, ENDPOINTS.imageCreate, payload, {
      logger: log,
      timeoutMs: 180_000, // 出图可能慢
    });
  } catch (err) {
    // 4xx 被拒 = 任务从未创建 = 没扣费。5xx / 网络中断 = 不确定。
    ledger.markFailed(jobId, err.message ?? String(err), {
      charged: chargeStatusOf(err),
    });
    log.error(describeCreateFailure(err));
    throw err;
  }

  // 图片接口是同步的，没有 task_id。用一个标记表示"调用已完成"，
  // 避免台账停在 submitting 而被误判成"结果未知"。
  ledger.markTaskId(jobId, `sync-${Date.now()}`);

  // ---- 解析 URL ----
  let parsed;
  try {
    parsed = parseImageUrl(response);
  } catch (err) {
    ledger.markFailed(jobId, `URL 解析失败：${err.message}`);
    log.error('图片已生成并扣费，但无法从响应里解析出 URL。');
    log.plain('');
    if (err instanceof ImageUrlParseError) {
      log.plain('  原始 content：');
      log.plain('  ' + '─'.repeat(60));
      log.plain(String(err.rawContent ?? '(空)').slice(0, 2000));
      log.plain('  ' + '─'.repeat(60));
      log.plain('');
      log.plain(`  请手动把图片 URL 填进 ${paths.shotsFile} 的 ${ref.id}.url 字段。`);
      log.plain('  不要直接重跑 —— 会再扣一次钱。');
    }
    throw err;
  }

  log.ok(`解析成功（格式：${parsed.format}）`);
  if (parsed.all.length > 1) {
    log.warn(`响应里有 ${parsed.all.length} 个 URL，已选第一个像图片的。其余：`);
    for (const u of parsed.all.slice(1, 4)) log.plain(`      ${u}`);
  }
  log.plain(`  URL：${parsed.url}`);

  // ---- 下载本地留档 ----
  const ext = (parsed.url.match(/\.(png|jpe?g|webp)(\?|#|$)/i)?.[1] ?? 'png').toLowerCase();
  const target = resolve(paths.refs, `${ref.id}.${ext}`);

  let dl;
  try {
    dl = await downloadPublic(parsed.url, target, { logger: log });
    log.ok(`已留档：${dl.path.replace(paths.root, '.')}（${humanSize(dl.bytes)}）`);
    if (dl.renamed) {
      log.warn('目标文件已存在，已改名保存，未覆盖原文件。');
    }
  } catch (err) {
    // 下载失败不致命 —— URL 还在，视频接口用的是 URL 不是本地文件
    log.warn(`本地留档失败：${err.message}`);
    log.warn('URL 仍然可用，流程继续。但建议手动下载一份备份。');
    dl = null;
  }

  // ---- 确认 URL 真的能被公网访问 ----
  const alive = await checkUrlAlive(parsed.url);
  if (!alive.alive) {
    ledger.markFailed(jobId, `URL 不可访问（status=${alive.status}）`);
    log.error(
      `URL 无法访问（status=${alive.status ?? alive.error}）。` +
        `视频接口需要公网可访问的 HTTPS URL，这个 URL 用不了。`
    );
    throw new Error(`参考图 URL 不可访问：${parsed.url}`);
  }
  log.ok(
    `URL 可访问（${alive.status}${alive.contentType ? `, ${alive.contentType}` : ''}` +
      `${alive.contentLength ? `, ${humanSize(alive.contentLength)}` : ''}）`
  );

  // ---- 写回 shots.json ----
  writeBackUrl(paths.shotsFile, ref.id, parsed.url, dl ? dl.path.replace(paths.root + '\\', '').replace(paths.root + '/', '') : null);
  log.ok(`URL 已写回 shots.json`);

  ledger.markSuccess(jobId, { outputPath: dl?.path ?? null, actualCny: estimated });

  return { ref, url: parsed.url, format: parsed.format, localPath: dl?.path ?? null };
}

async function main() {
  const args = parseArgs(process.argv);

  let config;
  try {
    config = loadConfig();
  } catch (e) {
    log.error(e.message);
    process.exitCode = 1;
    return;
  }
  registerSecrets([config.apiKey, config.lk888Key]);

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

  // 挑出要生成的参考图
  let refs = data.referenceImages;
  if (args.only) {
    refs = refs.filter((r) => r.id === args.only);
    if (refs.length === 0) {
      log.error(`找不到参考图 "${args.only}"。可用：${data.referenceImages.map((r) => r.id).join(', ')}`);
      process.exitCode = 1;
      return;
    }
  }

  // 台账过滤
  const todo = [];
  for (const ref of refs) {
    const jobId = `ref:${ref.id}`;
    const check = ledger.canSubmit(jobId, { force: args.force });

    if (!check.allowed) {
      log.plain(`  – ${check.message}`);
      continue;
    }
    if (ref.url && !args.force) {
      log.plain(`  – ${ref.id} 已有 URL，跳过。要重做请加 --force。`);
      continue;
    }
    todo.push({ ref, jobId });
  }

  if (args.limit && todo.length > args.limit) {
    log.plain('');
    log.info(`--limit ${args.limit}：本次只生成前 ${args.limit} 张。`);
    todo.length = args.limit;
  }

  if (todo.length === 0) {
    log.plain('');
    log.plain('没有需要生成的参考图。');
    return;
  }

  // ---- 报价 + 确认 ----
  log.plain('');
  log.plain('本次将生成：');
  for (const { ref } of todo) {
    log.plain(`  · ${ref.id}（${ref.role}）`);
  }

  const quote = quoteBatch({ images: todo.length, shots: [] }, config);

  try {
    await gate({
      quote,
      renderedQuote: renderQuote(quote, config),
      config,
      logger: log,
    });
  } catch (e) {
    if (e instanceof ConfirmationDeclined) {
      log.plain('');
      log.plain(e.message);
      return;
    }
    log.error(e.message);
    process.exitCode = 1;
    return;
  }

  // ---- 串行生成。失败即停。 ----
  const done = [];
  for (const { ref, jobId } of todo) {
    try {
      const r = await generateOne(ref, { config, ledger, paths, jobId });
      done.push(r);
    } catch (err) {
      log.plain('');
      log.error(`在 ${ref.id} 处中止。已完成 ${done.length}/${todo.length} 张。`);
      log.plain('');
      log.plain('  按规则不会自动重试。请先处理上面的问题，再重新运行。');
      log.plain(`  台账：${paths.state}\\jobs.json`);
      process.exitCode = 1;
      break;
    }
  }

  // ---- 汇总 ----
  if (done.length) {
    log.plain('');
    log.plain('─'.repeat(64));
    log.ok(`完成 ${done.length} 张参考图`);
    for (const d of done) {
      log.plain(`  ${d.ref.id}  ${d.format}`);
      log.plain(`    ${d.url}`);
    }
    log.plain('');
    log.plain(`  累计花费（本项目）：${fmt(ledger.totalSpent())}`);
    log.plain('─'.repeat(64));

    // 试水模式的提示
    if (args.limit === 1 || (args.only && done.length === 1)) {
      log.plain('');
      log.plain('  试水完成。请确认：');
      log.plain('    1. 打开本地图片看画面对不对');
      log.plain(`    2. 返回格式是 ${done[0].format}，解析器已适配`);
      log.plain('    3. 确认无误后跑 npm run refs 生成其余两张');
      log.plain('');
    }
  }
}

main().catch((e) => {
  log.error(`未预期的错误：${e?.message ?? e}`);
  process.exitCode = 1;
});
