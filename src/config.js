/**
 * 配置加载：自己解析 .env，不引第三方包。
 * 启动即校验，配置不合法就直接抛错，不留到调用 API 时才发现。
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Secret } from './secret.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 极简 .env 解析：KEY=VALUE，支持 # 注释、引号、空行。 */
function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function loadEnv() {
  const envPath = resolve(ROOT, '.env');
  if (!existsSync(envPath)) {
    throw new Error(
      '找不到 .env 文件。请把 .env.example 复制成 .env，并填入 XINLIU_MEDIA_API_KEY。'
    );
  }
  const fileEnv = parseEnvFile(readFileSync(envPath, 'utf8'));
  // 真实环境变量优先于文件，方便临时覆盖
  return { ...fileEnv, ...process.env };
}

function num(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`配置 ${key} 不是有效数字：${raw}`);
  }
  return n;
}

function posInt(env, key, fallback) {
  const n = num(env, key, fallback);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`配置 ${key} 必须是正整数，当前为：${n}`);
  }
  return n;
}

/**
 * @param {object}  o
 * @param {boolean} o.requireKey  是否必须有心流密钥（图片生成用）
 * @param {boolean} o.requireLk888Key  是否必须有 lk888 密钥（视频生成用）
 *
 * 两个密钥分开要求：跑 npm run refs 只需要心流的，
 * 跑视频只需要 lk888 的。缺哪个就报哪个，不要逼用户两个都填才能动。
 */
export function loadConfig({ requireKey = true, requireLk888Key = false } = {}) {
  const env = loadEnv();

  const apiKey = new Secret(env.XINLIU_MEDIA_API_KEY ?? '', 'XINLIU_MEDIA_API_KEY');
  if (requireKey && apiKey.isEmpty()) {
    throw new Error(
      '.env 里的 XINLIU_MEDIA_API_KEY 是空的。请填入心流后台的媒体 API 密钥（令牌分组需为 low）。'
    );
  }

  const lk888Key = new Secret(env.LK888_MEDIA_API_KEY ?? '', 'LK888_MEDIA_API_KEY');
  if (requireLk888Key && lk888Key.isEmpty()) {
    throw new Error(
      '.env 里的 LK888_MEDIA_API_KEY 是空的。请填入 lk888 后台的 API 密钥。\n' +
        '    视频生成走 lk888（gk-video-3.5），与心流的密钥是两个不同的值。'
    );
  }

  const baseUrl = (env.XINLIU_BASE_URL ?? 'https://iliu.ai').replace(/\/+$/, '');
  if (!baseUrl.startsWith('https://')) {
    throw new Error(`XINLIU_BASE_URL 必须是 https 地址，当前为：${baseUrl}`);
  }

  const lk888BaseUrl = (env.LK888_BASE_URL ?? 'https://api.lk888.ai').replace(/\/+$/, '');
  if (!lk888BaseUrl.startsWith('https://')) {
    throw new Error(`LK888_BASE_URL 必须是 https 地址，当前为：${lk888BaseUrl}`);
  }

  const ratio = num(env, 'XINLIU_RECHARGE_RATIO', 0.5);
  if (ratio <= 0 || ratio > 1) {
    throw new Error(`XINLIU_RECHARGE_RATIO 应在 0~1 之间，当前为：${ratio}`);
  }

  return {
    // --- 心流：只用于生成图片 ---
    apiKey,
    baseUrl,
    imageModel: env.XINLIU_IMAGE_MODEL ?? 'grok-imagine-image-2.0',

    // --- lk888：只用于生成视频 ---
    lk888Key,
    lk888BaseUrl,
    videoModel: env.LK888_VIDEO_MODEL ?? 'gk-video-3.5',

    price: {
      imagePerCall: num(env, 'XINLIU_IMAGE_PRICE_PER_CALL', 0.08),
      rechargeRatio: ratio,

      // lk888 按秒计费，单位已是人民币元，不再乘 rechargeRatio。
      // 这一点和心流不同 —— 心流的价格是平台额度，要折算。
      videoPerSecondCny: {
        '720p': num(env, 'LK888_VIDEO_PRICE_PER_SECOND_720P', 0.1656),
        '480p': num(env, 'LK888_VIDEO_PRICE_PER_SECOND_480P', 0.1656),
      },
    },

    videoConcurrency: posInt(env, 'VIDEO_CONCURRENCY', 1),
    imageConcurrency: posInt(env, 'IMAGE_CONCURRENCY', 1),
    pollIntervalSeconds: posInt(env, 'POLL_INTERVAL_SECONDS', 8),
    videoTimeoutMinutes: posInt(env, 'VIDEO_TIMEOUT_MINUTES', 70),

    defaultSeconds: posInt(env, 'DEFAULT_VIDEO_SECONDS', 6),
    defaultResolution: env.DEFAULT_VIDEO_RESOLUTION ?? '720p',
    defaultAspectRatio: env.DEFAULT_ASPECT_RATIO ?? '16:9',

    requireConfirmation: (env.REQUIRE_CONFIRMATION ?? 'true') !== 'false',
    maxSpendPerBatchCny: num(env, 'MAX_SPEND_PER_BATCH_CNY', 10),
  };
}

/** 心流请求头（图片）。reveal() 只在本文件调用。 */
export function authHeaders(config) {
  return {
    Authorization: `Bearer ${config.apiKey.reveal()}`,
    'Content-Type': 'application/json',
  };
}

/** lk888 请求头（视频）。文档说同时带多个鉴权头时以 Bearer 为准，这里只用 Bearer。 */
export function lk888AuthHeaders(config) {
  return {
    Authorization: `Bearer ${config.lk888Key.reveal()}`,
    'Content-Type': 'application/json',
  };
}
