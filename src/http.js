/**
 * HTTP 层。
 *
 * 唯一的重试策略在这里集中实现：
 *   apiGet  —— 允许退避重试（transient / rate_limit），最多 3 次
 *   apiPost —— 永不自动重试，任何失败直接抛出
 *
 * 这个不对称是刻意的：GET 重试不花钱，POST 重试可能重复扣费。
 */

import { authHeaders, lk888AuthHeaders } from './config.js';
import {
  ApiError,
  classifyHttpError,
  classifyNetworkError,
  RETRY_DELAYS_MS,
  MAX_GET_RETRIES,
} from './errors.js';
import { ENDPOINTS } from './fieldMap.js';

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * 按平台取 base URL 和鉴权头。
 *
 * 图片走心流、视频走 lk888，两套凭据并存。默认 'xinliu' 是为了
 * 让已有调用点不用改就保持原行为。
 */
function targetOf(config, provider) {
  if (provider === 'lk888') {
    return { base: config.lk888BaseUrl, headers: lk888AuthHeaders(config) };
  }
  return { base: config.baseUrl, headers: authHeaders(config) };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readBody(res) {
  const text = await res.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function rawRequest(url, { method, headers, body, timeoutMs }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    const parsed = await readBody(res);
    return { res, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

/** GET：允许退避重试。查询状态、列模型、下载元信息都走这里。 */
export async function apiGet(config, path, { timeoutMs, logger, provider } = {}) {
  const { base, headers } = targetOf(config, provider);
  const url = base + path;
  let lastErr = null;

  for (let attempt = 0; attempt <= MAX_GET_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt - 1] ?? 20000;
      logger?.warn(
        `GET ${path} 第 ${attempt} 次重试，等待 ${delay / 1000} 秒…（上次：${lastErr?.message?.split('\n')[0] ?? '未知'}）`
      );
      await sleep(delay);
    }

    try {
      const { res, body } = await rawRequest(url, {
        method: 'GET',
        headers,
        timeoutMs,
      });

      if (res.ok) return body;

      const { category, hint } = classifyHttpError(res.status, body);
      const err = new ApiError({
        status: res.status,
        body,
        url,
        method: 'GET',
        category,
        hint,
      });

      // GET 允许对 transient 和 429 重试
      if (category === 'transient' || category === 'rate_limit') {
        lastErr = err;
        continue;
      }
      throw err; // fatal / moderation 立即放弃
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.category === 'transient' || err.category === 'rate_limit') {
          lastErr = err;
          continue;
        }
        throw err;
      }
      const net = classifyNetworkError(err);
      if (net.category === 'transient') {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }

  throw lastErr ?? new Error(`GET ${path} 重试 ${MAX_GET_RETRIES} 次后仍失败`);
}

/**
 * POST：绝不自动重试。
 *
 * 失败时抛出的错误里带着 requestReached 标记，供上层判断
 * 「钱可能扣了」还是「肯定没扣」。
 */
export async function apiPost(config, path, payload, { timeoutMs, logger, provider } = {}) {
  const { base, headers } = targetOf(config, provider);
  const url = base + path;

  try {
    const { res, body } = await rawRequest(url, {
      method: 'POST',
      headers,
      body: payload,
      timeoutMs,
    });

    if (res.ok) return body;

    const { category, hint } = classifyHttpError(res.status, body);
    const err = new ApiError({
      status: res.status,
      body,
      url,
      method: 'POST',
      category,
      hint,
    });
    // 收到了明确的 HTTP 错误码，说明请求到达了服务端并被拒绝。
    // 4xx 拒绝通常不扣费，5xx 则不确定。
    err.requestReached = true;
    err.chargeUncertain = res.status >= 500;
    throw err;
  } catch (err) {
    if (err instanceof ApiError) throw err;

    // 网络层失败：无法确认服务端有没有收到
    const net = classifyNetworkError(err);
    const wrapped = new Error(
      `POST ${path} 网络异常（${net.code || err.message}）。${net.hint}`
    );
    wrapped.name = 'NetworkError';
    wrapped.cause = err;
    wrapped.category = net.category;
    wrapped.requestReached = null; // 未知
    wrapped.chargeUncertain = true;
    throw wrapped;
  }
}

/** 列出可用模型。免费调用。 */
export async function listModels(config, { logger } = {}) {
  const body = await apiGet(config, ENDPOINTS.models, { logger, timeoutMs: 30_000 });
  const arr = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  return arr
    .map((m) => (typeof m === 'string' ? m : m?.id ?? m?.model ?? null))
    .filter(Boolean);
}
