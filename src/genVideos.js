#!/usr/bin/env node
/**
 * 视频生成。npm run video [-- 项目] [--only shot-01] [--limit 1] [--force]
 *
 * ⚠ 收费命令。走 lk888 gk-video-3.5，按秒计费。
 *
 * 单个镜头的完整流程：
 *   查台账 → 校验参数 → 确认首帧图 URL 还活着 → 报价 → 等「确认生成」
 *   → 台账落 submitting → POST /v1/media/generate（零重试）
 *   → 拿到 task_id 立刻写台账 → 轮询（免费，可重试）
 *   → 下载 MP4 → ffprobe 校验 → 台账标成功
 *
 * 每个镜头带自己的首帧参考图（shot.firstFrame），不再是全项目共用一组
 * 风格参考图 —— gk-video-3.5 的 images 只收 1 张，且这张是视频第一帧。
 *
 * 串行执行。任一镜头失败即停止整批 —— 失败往往是共性问题
 * （首帧图失效、提示词被审核），继续跑只会连续扣钱。
 */

import { resolve, isAbsolute, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

import { loadConfig } from './config.js';
import { log, registerSecrets } from './logger.js';
import { resolveProject, loadShots, projectPaths } from './project.js';
import { Ledger, planSubmission } from './jobs.js';
import { quoteShot, quoteBatch, renderQuote, fmt } from './pricing.js';
import { gate, ConfirmationDeclined } from './confirm.js';
import { apiPost } from './http.js';
import { buildVideoPayload, ENDPOINTS, extractTaskId } from './lk888.js';
import { pollUntilDone } from './poll.js';
import { downloadPublic, checkUrlAlive, humanSize } from './download.js';
import { verifyVideo, describeVideo } from './ffprobe.js';
import { describeCreateFailure, ApiError } from './errors.js';

function parseArgs(argv) {
  const args = {
    project: null,
    only: [],
    limit: null,
    force: false,
    timeout: null,
    // 首帧图改用 base64 data URI 内嵌，而不是给 URL 让平台自己去拉。
    // 心流时代这是排查手段，在这里保留是因为它仍是「平台拉不到图」时
    // 唯一的绕法 —— 图片存在心流 COS 上，lk888 未必拉得动。
    base64: false,
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--force') args.force = true;
    else if (a === '--refs-base64') args.base64 = true;
    else if (a === '--only') args.only.push(rest[++i]);
    else if (a === '--limit') args.limit = Number(rest[++i]);
    else if (a === '--timeout') args.timeout = Number(rest[++i]);
    else if (a === '--no-refs' || a === '--refs') {
      throw new Error(
        `${a} 已失效。gk-video-3.5 是图生视频模型，必须带且只能带 1 张首帧图，\n` +
          `    不带图提交一定会被拒。首帧图在 shots.json 里每个镜头的 firstFrame 字段。`
      );
    } else if (!a.startsWith('--')) args.project = a;
  }
  return args;
}

/** 4xx = 任务未创建 = 没扣费；5xx / 网络中断 = 不确定。 */
function chargeStatusOf(err) {
  if (err instanceof ApiError && typeof err.status === 'number') {
    return err.status >= 400 && err.status < 500 ? false : null;
  }
  return null;
}

/**
 * 取一个镜头的首帧图，返回能直接放进 images 的字符串。
 *
 * gk-video-3.5 只收 1 张图，且它就是视频第一帧，所以首帧图是「每镜一张」
 * 而不是全项目共用。shots.json 里每个镜头用 firstFrame 指一张参考图的 id。
 *
 * 返回 null 表示这个镜头没配好，调用方负责报错退出（不要带着空图提交，
 * 图生视频模型没图一定被拒，白发一次请求）。
 */
async function resolveFirstFrame(shot, refs, { projectDir, base64 }) {
  const ref = refs.find((r) => r.id === shot.firstFrame);
  if (!ref) {
    return {
      error:
        `${shot.id} 的 firstFrame 指向 "${shot.firstFrame ?? '(未设置)'}"，` +
        `在 referenceImages 里找不到。\n` +
        `    可用的：${refs.map((r) => r.id).join(', ') || '(一张都没有)'}`,
    };
  }

  if (base64) {
    // 把图内嵌进请求，绕开「平台能不能访问图片所在域名」这个问题。
    // 图片存在心流 COS 上，lk888 未必拉得动。
    if (!ref.localPath) {
      return { error: `${shot.id} 的首帧图 ${ref.id} 没有 localPath，请先 npm run refs` };
    }
    const abs = isAbsolute(ref.localPath) ? ref.localPath : join(projectDir, ref.localPath);
    if (!existsSync(abs)) {
      return { error: `${shot.id} 的首帧图本地文件不存在：${abs}` };
    }
    const buf = readFileSync(abs);
    const mime = abs.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    const uri = `data:${mime};base64,${buf.toString('base64')}`;
    log.plain(
      `      ✓ ${shot.id} ← ${ref.id}  ${humanSize(buf.length)} → base64 ${humanSize(uri.length)}`
    );
    if (uri.length > 4 * 1024 * 1024) {
      log.warn(`${shot.id} 的 base64 超过 4MB，网关可能拒绝这么大的请求体。`);
    }
    return { uri };
  }

  if (!ref.url) {
    return { error: `${shot.id} 的首帧图 ${ref.id} 没有 url，请先 npm run refs` };
  }
  // URL 失效会让整次提交白等一轮，提交前先确认还活着
  const alive = await checkUrlAlive(ref.url);
  if (!alive.alive) {
    return {
      error:
        `${shot.id} 的首帧图 ${ref.id} URL 已不可访问（${alive.status ?? alive.error}）。\n` +
        `    重新生成：npm run refs -- --only ${ref.id} --force`,
    };
  }
  log.plain(
    `      ✓ ${shot.id} ← ${ref.id}  ${alive.status}  ` +
      `${alive.contentLength ? humanSize(alive.contentLength) : ''}`
  );
  return { uri: ref.url };
}

/**
 * 提交并完成一个镜头。
 */
async function runShot(shot, firstFrameUri, ctx) {
  const { config, ledger, paths, timeoutMinutes } = ctx;
  const id = shot.id;

  log.plain('');
  log.plain('─'.repeat(64));
  log.info(`${id}  ${shot.seconds}秒 ${shot.resolution} ${config.defaultAspectRatio}`);

  const estimated = quoteShot(shot, config).totalCny;

  // ---- 提交前落痕。必须在 HTTP 请求之前。 ----
  // base64 的 data URI 一张就 400KB，原样写进台账会把 jobs.json 撑爆，
  // 而且台账是给人看的。只记摘要，够还原「这次带了什么」就行。
  const refForLedger = firstFrameUri.startsWith('data:')
    ? `${firstFrameUri.slice(0, firstFrameUri.indexOf(',') + 1)}…（${firstFrameUri.length} 字符 base64）`
    : firstFrameUri;

  ledger.markSubmitting(id, {
    model: config.videoModel,
    seconds: shot.seconds,
    resolution: shot.resolution,
    referenceImages: [refForLedger],
    prompt: shot.prompt,
    estimatedCny: estimated,
  });

  const payload = buildVideoPayload({
    model: config.videoModel,
    prompt: shot.prompt,
    images: [firstFrameUri],
    seconds: shot.seconds,
    resolution: shot.resolution,
    aspectRatio: config.defaultAspectRatio,
  });

  log.plain(`      提交 POST ${ENDPOINTS.videoCreate}（lk888）`);
  log.plain(
    `      duration="${payload.params.duration}" aspect_ratio=${payload.params.aspect_ratio} ` +
      `resolution=${payload.params.resolution} 首帧图 1 张`
  );

  // ---- 创建任务。零重试。 ----
  let response;
  try {
    response = await apiPost(config, ENDPOINTS.videoCreate, payload, {
      logger: log,
      timeoutMs: 120_000,
      provider: 'lk888',
    });
  } catch (err) {
    ledger.markFailed(id, err.message ?? String(err), { charged: chargeStatusOf(err) });
    log.plain('');
    log.error(describeCreateFailure(err));
    throw err;
  }

  // ---- 拿到 task_id 立刻写台账。这是最关键的一次写入。 ----
  const taskId = extractTaskId(response);
  if (!taskId) {
    ledger.markFailed(id, '创建成功但响应里没有 task_id', { charged: null });
    log.error('创建请求返回 200，但找不到 task_id。任务可能已创建并扣费。');
    log.plain('');
    log.plain('  响应原文：');
    log.plain('  ' + JSON.stringify(response, null, 2).slice(0, 1500));
    log.plain('');
    log.plain('  请到 lk888 后台任务列表查看这笔任务，不要直接重跑。');
    throw new Error(`${id}：响应里没有 task_id`);
  }

  ledger.markTaskId(id, taskId);
  log.ok(`task_id = ${taskId}（已写入台账）`);

  // ---- 轮询。免费，可自动重试。 ----
  log.plain(`      轮询中，每 ${config.pollIntervalSeconds} 秒一次…`);
  const result = await pollUntilDone(config, taskId, {
    logger: log,
    timeoutMinutes: timeoutMinutes ?? config.videoTimeoutMinutes,
    provider: 'lk888',
  });

  if (result.outcome === 'failure') {
    // lk888 对失败任务自动退款，所以这里记 charged: false 而不是 null。
    // 心流时代只能保守按「可能扣了」算，这家能记准。
    ledger.markFailed(id, result.error, { charged: false });
    log.error(`生成失败：${result.error}`);
    log.plain('');
    log.plain('  lk888 对失败任务自动退款，本次记 0 元。');
    log.plain('  按规则不自动重提。请先修改提示词或首帧图，再用 --force 重新提交。');
    throw new Error(`${id} 生成失败`);
  }

  if (result.outcome === 'timeout') {
    // 超时不标 failed —— 任务可能还在跑，标 failed 会让 --force 重复扣费
    log.warn(result.error);
    log.plain('');
    log.plain(`  台账里保留 pending 状态和 task_id。稍后运行：`);
    log.plain(`      npm run status`);
    throw new Error(`${id} 轮询超时（任务可能仍在进行）`);
  }

  log.ok(`生成完成（耗时 ${Math.round(result.elapsedMs / 1000)} 秒，轮询 ${result.polls} 次）`);

  // ---- 下载。优先用返回的直链，没有就走 /content 端点。 ----
  // lk888 没有 /content 端点，成片只能从 result_url 取。没有 URL 就是异常，
  // 但钱已经花了 —— 不标 failed，让 npm run status 能重试下载。
  const target = resolve(paths.input, `${id}.mp4`);
  if (!result.videoUrl) {
    log.error('任务成功但响应里没有 result_url，无法下载。');
    log.plain('');
    log.plain('  费用已产生，台账保留 pending。响应原文：');
    log.plain('  ' + JSON.stringify(result.response, null, 2).slice(0, 1000));
    throw new Error(`${id}：成功但没有 result_url`);
  }

  let dl;
  try {
    log.plain(`      下载 ${result.videoUrl.slice(0, 70)}…`);
    dl = await downloadPublic(result.videoUrl, target, { logger: log });
  } catch (err) {
    // 下载失败但任务已成功 —— 钱花了，素材还在服务端。
    // 不标 failed，否则 --force 会重新生成、重复扣费。
    log.error(`下载失败：${err.message}`);
    log.plain('');
    log.plain('  任务已生成成功，费用已产生。台账保留 pending 状态。');
    log.plain('  素材还在服务端，重跑 npm run status 可以只重试下载，不会重新生成。');
    throw new Error(`${id} 下载失败`);
  }

  log.ok(`已下载：${dl.path.replace(paths.root, '.')}（${humanSize(dl.bytes)}）`);
  if (dl.renamed) log.warn('目标文件已存在，已改名保存，未覆盖原文件。');

  // ---- ffprobe 校验 ----
  // lk888 给的是 aspect_ratio + resolution，不是精确像素串，实际出片尺寸
  // 由平台决定。所以只校验时长，尺寸交给 describeVideo 打印出来人工看。
  const check = await verifyVideo(dl.path, { seconds: shot.seconds });

  if (check.info) log.plain(`      ${describeVideo(check.info)}`);

  if (!check.ok) {
    log.warn('文件校验发现问题：');
    for (const p of check.problems) log.plain(`        · ${p}`);
    log.plain('      文件已保留，请人工确认是否可用。');
  } else {
    log.ok('文件校验通过');
  }

  ledger.markSuccess(id, { outputPath: dl.path, actualCny: estimated });

  return { shot, taskId, path: dl.path, info: check.info, verified: check.ok };
}

async function main() {
  const args = parseArgs(process.argv);

  let config;
  try {
    // 视频走 lk888，这条命令必须有 lk888 的 key 才能跑
    config = loadConfig({ requireLk888Key: true });
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

  log.plain('');
  log.plain(`项目：${data.meta.title ?? projectDir}`);

  for (const w of data.warnings) log.warn(w);

  // ---- 挑镜头 ----
  let shots = data.shots;
  if (args.only.length) {
    shots = shots.filter((s) => args.only.includes(s.id));
    if (shots.length === 0) {
      log.error(`找不到镜头：${args.only.join(', ')}。可用：${data.shots.map((s) => s.id).join(', ')}`);
      process.exitCode = 1;
      return;
    }
  }

  const ledger = new Ledger(projectDir);
  const plan = planSubmission(shots, ledger, { force: args.force });

  if (plan.blocked.length) {
    log.plain('');
    for (const b of plan.blocked) log.plain(`  ✖ ${b.message}`);
  }
  if (plan.skipped.length) {
    log.plain('');
    for (const s of plan.skipped) log.plain(`  – ${s.message}`);
  }

  let todo = plan.toSubmit.map((t) => t.shot);
  if (args.limit && todo.length > args.limit) {
    log.plain('');
    log.info(`--limit ${args.limit}：本次只生成前 ${args.limit} 个镜头。`);
    todo = todo.slice(0, args.limit);
  }

  if (todo.length === 0) {
    log.plain('');
    log.plain('没有需要生成的镜头。');
    const s = ledger.summary();
    if (s.total) log.plain(`台账：${JSON.stringify(s.byStatus)}，累计 ${fmt(s.totalSpentCny)}`);
    return;
  }

  // ---- 首帧图：每镜一张，提交前全部确认可用 ----
  // 放在报价之后、确认之前没有意义 —— 图没配好就不该让用户看报价。
  // 所以先把所有镜头的图都解析好，一张不行就整批停下。
  log.plain('');
  log.info(args.base64 ? '读取首帧图（base64 内嵌）…' : '检查首帧图 URL 可访问性…');

  const frames = new Map();
  for (const shot of todo) {
    const r = await resolveFirstFrame(shot, data.referenceImages, {
      projectDir,
      base64: args.base64,
    });
    if (r.error) {
      log.error(r.error);
      log.plain('');
      log.plain('  gk-video-3.5 是图生视频模型，每个镜头必须有一张首帧图。');
      log.plain('  未提交任何任务，未产生费用。');
      process.exitCode = 1;
      return;
    }
    frames.set(shot.id, r.uri);
  }

  // ---- 报价 + 确认 ----
  const quote = quoteBatch({ images: 0, shots: todo }, config);
  try {
    await gate({ quote, renderedQuote: renderQuote(quote, config), config, logger: log });
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

  // ---- 串行执行。失败即停整批。 ----
  const done = [];
  for (const shot of todo) {
    try {
      done.push(
        await runShot(shot, frames.get(shot.id), {
          config,
          ledger,
          paths,
          timeoutMinutes: args.timeout,
        })
      );
    } catch {
      log.plain('');
      log.plain('─'.repeat(64));
      log.error(`在 ${shot.id} 处中止。已完成 ${done.length}/${todo.length} 个镜头。`);
      log.plain('');
      log.plain('  失败往往是共性问题（首帧图失效、提示词被审核），');
      log.plain('  所以剩余镜头不会继续提交，避免连续扣费。');
      log.plain('');
      log.plain(`  台账：${paths.state}\\jobs.json`);
      process.exitCode = 1;
      break;
    }
  }

  // ---- 汇总 ----
  if (done.length) {
    log.plain('');
    log.plain('═'.repeat(64));
    log.ok(`完成 ${done.length} 个镜头`);
    for (const d of done) {
      log.plain(`  ${d.shot.id}  ${d.verified ? '✓' : '⚠'}  ${describeVideo(d.info)}`);
    }
    log.plain('');
    log.plain(`  累计花费（本项目）：${fmt(ledger.totalSpent())}`);
    log.plain('═'.repeat(64));

    const remaining = data.shots.length - ledger.all().filter((j) => j.status === 'success' && !j.id.startsWith('ref:')).length;
    if (remaining <= 0) {
      log.plain('');
      log.plain('  所有镜头就绪。下一步拼接：');
      log.plain('      npm run edit');
      log.plain('');
    } else if (todo.length === 1) {
      log.plain('');
      log.plain('  试水完成。确认画面无误后生成其余镜头：');
      log.plain('      npm run video');
      log.plain('');
    }
  }
}

main().catch((e) => {
  log.error(`未预期的错误：${e?.message ?? e}`);
  process.exitCode = 1;
});
