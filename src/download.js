/**
 * 下载与文件落地。
 *
 * 铁律：绝不覆盖已有文件。同名时自动加 -2、-3 后缀。
 * 素材和成片都是花钱换来的，覆盖比多占几 MB 磁盘严重得多。
 */

import { writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname, extname, basename } from 'node:path';
import { authHeaders } from './config.js';
import {
  ApiError,
  classifyHttpError,
  classifyNetworkError,
  RETRY_DELAYS_MS,
  MAX_GET_RETRIES,
} from './errors.js';

const DOWNLOAD_TIMEOUT_MS = 180_000; // 视频文件可能不小

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 找一个不冲突的文件名。
 * a.png 已存在 → a-2.png → a-3.png …
 */
export function uniquePath(targetPath) {
  if (!existsSync(targetPath)) return targetPath;

  const dir = dirname(targetPath);
  const ext = extname(targetPath);
  const stem = basename(targetPath, ext);

  for (let i = 2; i < 1000; i++) {
    const candidate = resolve(dir, `${stem}-${i}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`同名文件过多，无法为 ${targetPath} 找到可用名字`);
}

/** 确认远端 URL 还活着。参考图 URL 可能有时效，提交视频前必须查。 */
export async function checkUrlAlive(url, { timeoutMs = 20_000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // 有些 CDN 不支持 HEAD，失败了再用 Range GET 兜一下
    let res = await fetch(url, { method: 'HEAD', signal: ctl.signal }).catch(() => null);

    if (!res || res.status === 405 || res.status === 501) {
      res = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        signal: ctl.signal,
      });
    }

    return {
      alive: res.ok || res.status === 206,
      status: res.status,
      contentType: res.headers.get('content-type'),
      contentLength: Number(res.headers.get('content-length')) || null,
    };
  } catch (e) {
    return { alive: false, status: null, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 下载任意公网文件（参考图用）。不带鉴权头。
 * GET 允许退避重试。
 */
export async function downloadPublic(url, targetPath, { logger } = {}) {
  return downloadInternal(url, targetPath, { headers: {}, logger });
}

/**
 * 下载心流接口的内容（视频用）。带鉴权头。
 */
export async function downloadAuthed(config, path, targetPath, { logger } = {}) {
  const url = config.baseUrl + path;
  return downloadInternal(url, targetPath, {
    headers: { Authorization: authHeaders(config).Authorization },
    logger,
  });
}

async function downloadInternal(url, targetPath, { headers, logger }) {
  let lastErr = null;

  for (let attempt = 0; attempt <= MAX_GET_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt - 1] ?? 20000;
      logger?.warn(`下载重试第 ${attempt} 次，等待 ${delay / 1000} 秒…`);
      await sleep(delay);
    }

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), DOWNLOAD_TIMEOUT_MS);

    try {
      const res = await fetch(url, { method: 'GET', headers, signal: ctl.signal });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const { category, hint } = classifyHttpError(res.status, body);
        const err = new ApiError({
          status: res.status,
          body: body.slice(0, 500),
          url,
          method: 'GET',
          category,
          hint,
        });
        if (category === 'transient' || category === 'rate_limit') {
          lastErr = err;
          continue;
        }
        throw err;
      }

      const buf = Buffer.from(await res.arrayBuffer());

      if (buf.length === 0) {
        lastErr = new Error('下载到 0 字节');
        continue;
      }

      // 防呆：返回的可能是一个 HTML 错误页而不是媒体文件
      const head = buf.subarray(0, 64).toString('latin1').toLowerCase();
      if (head.includes('<!doctype html') || head.includes('<html')) {
        throw new Error(
          `下载到的是 HTML 页面而不是媒体文件（${buf.length} 字节）。` +
            `URL 可能已失效或需要鉴权：${url}`
        );
      }

      const dir = dirname(targetPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const finalPath = uniquePath(targetPath);
      writeFileSync(finalPath, buf);

      return {
        path: finalPath,
        bytes: buf.length,
        renamed: finalPath !== targetPath,
        contentType: res.headers.get('content-type'),
      };
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
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr ?? new Error(`下载 ${url} 重试 ${MAX_GET_RETRIES} 次后仍失败`);
}

/** 人类可读的文件大小。 */
export function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 读本地文件大小，不存在返回 null。 */
export function fileSize(p) {
  try {
    return statSync(p).size;
  } catch {
    return null;
  }
}
