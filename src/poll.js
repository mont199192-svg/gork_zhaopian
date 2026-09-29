/**
 * 任务状态轮询。
 *
 * 这一步不花钱，所以可以自动重试、自动轮询。
 * 但要有超时上限 —— 任务卡死时不能无限轮下去。
 *
 * 轮询中断不算失败：台账里 task_id 还在，下次跑 npm run status 接着查。
 */

import { apiGet } from './http.js';
import * as xinliu from './fieldMap.js';
import * as lk888 from './lk888.js';

const DEFAULT_TIMEOUT_MIN = 20;

/**
 * 两家平台的状态字段完全不同，用适配器抹平：
 *   心流   status 字符串 → classifyStatus
 *   lk888  state + is_final → classifyTask，另有 progress 百分比
 *
 * 轮询逻辑本身（退避、超时、unknown 容忍度）两家共用。
 */
const ADAPTERS = {
  xinliu: {
    statusPath: (taskId) => xinliu.ENDPOINTS.videoStatus(taskId),
    classify: (res) => xinliu.classifyStatus(xinliu.extractStatus(res)),
    label: (res) => xinliu.extractStatus(res),
    videoUrl: (res) => xinliu.extractVideoUrl(res),
    error: (res) => xinliu.extractError(res),
    cost: () => null,
  },
  lk888: {
    statusPath: (taskId) => lk888.ENDPOINTS.videoStatus(taskId),
    classify: (res) => lk888.classifyTask(res),
    label: (res) => {
      const state = res?.state ?? res?.data?.state ?? null;
      const pct = lk888.extractProgress(res);
      return pct === null ? state : `${state ?? '?'} ${pct}%`;
    },
    videoUrl: (res) => lk888.extractVideoUrl(res),
    error: (res) => lk888.extractError(res),
    cost: (res) => lk888.extractCost(res),
  },
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtElapsed(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

/**
 * 轮询单个任务直到结束。
 *
 * @returns {{ outcome: 'success'|'failure'|'timeout', status, response, videoUrl, error, elapsedMs, polls }}
 */
export async function pollUntilDone(
  config,
  taskId,
  { logger, timeoutMinutes, provider = 'xinliu' } = {}
) {
  const ad = ADAPTERS[provider];
  if (!ad) throw new Error(`未知平台 "${provider}"，只支持 xinliu / lk888。`);
  const timeoutMs = (timeoutMinutes ?? DEFAULT_TIMEOUT_MIN) * 60_000;
  const intervalMs = config.pollIntervalSeconds * 1000;
  const started = Date.now();

  let polls = 0;
  let lastStatus = null;
  let unknownStreak = 0;

  while (true) {
    const elapsed = Date.now() - started;

    if (elapsed > timeoutMs) {
      return {
        outcome: 'timeout',
        status: lastStatus,
        elapsedMs: elapsed,
        polls,
        error:
          `轮询超过 ${timeoutMinutes ?? DEFAULT_TIMEOUT_MIN} 分钟仍未完成（最后状态：${lastStatus ?? '未知'}）。\n` +
          `    任务可能还在跑。task_id 已存在台账里，稍后用 npm run status 继续查，不要重新提交。`,
      };
    }

    polls++;
    let response;
    try {
      response = await apiGet(config, ad.statusPath(taskId), { logger, provider });
    } catch (err) {
      // GET 已在 http 层重试过 3 次，到这里说明确实查不动了。
      // 这不等于任务失败 —— 任务可能还在服务端跑着。
      return {
        outcome: 'timeout',
        status: lastStatus,
        elapsedMs: Date.now() - started,
        polls,
        error:
          `查询状态失败：${err.message}\n` +
          `    这不代表任务失败。task_id 在台账里，稍后用 npm run status 继续查。`,
      };
    }

    const status = ad.label(response);
    const kind = ad.classify(response);

    if (status !== lastStatus) {
      logger?.plain(
        `      ${fmtElapsed(Date.now() - started).padStart(9)}  状态：${status ?? '(无 status 字段)'}`
      );
      lastStatus = status;
    }

    if (kind === 'success') {
      return {
        outcome: 'success',
        status,
        response,
        videoUrl: ad.videoUrl(response),
        cost: ad.cost(response),
        elapsedMs: Date.now() - started,
        polls,
      };
    }

    if (kind === 'failure') {
      return {
        outcome: 'failure',
        status,
        response,
        error: ad.error(response) ?? `任务状态为 ${status}`,
        elapsedMs: Date.now() - started,
        polls,
      };
    }

    if (kind === 'unknown') {
      unknownStreak++;
      // 状态字段读不懂时，先按 pending 继续轮，但别无限容忍
      if (unknownStreak === 1) {
        logger?.warn(
          `无法识别的状态 "${status}"，暂按进行中处理。响应片段：` +
            JSON.stringify(response).slice(0, 200)
        );
      }
      if (unknownStreak > 20) {
        return {
          outcome: 'timeout',
          status,
          response,
          elapsedMs: Date.now() - started,
          polls,
          error:
            `连续 ${unknownStreak} 次读到无法识别的状态 "${status}"，停止轮询。\n` +
            `    可能是状态字段名变了。请把上面的响应片段发给开发者，或用 npm run status 手动查。`,
        };
      }
    } else {
      unknownStreak = 0;
    }

    await sleep(intervalMs);
  }
}
