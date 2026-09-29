/**
 * 接口字段映射。
 *
 * 心流将来若改字段名，只动这个文件，不动业务代码。
 * 默认映射来自 2026-xx 心流文档确认版本。
 */

import { ValidationError } from './validate.js';

/**
 * 分辨率 → size 字符串（横屏 16:9）。
 *
 * 2026-09-28 实测：grok-imagine-video-1.5 只接受这两个值。
 *   seconds="15" size="720x1280" →
 *   {"code":"invalid_size","message":"Grok video size must be 1280x720 or 1920x1080"}
 *
 * 所以没有 480p 这一档，也没有任何竖屏尺寸。
 */
export const LANDSCAPE_SIZE = {
  '720p': '1280x720',
  '1080p': '1920x1080',
};

/**
 * 竖屏 9:16 —— 本模型不支持，保留仅为给出清楚的报错。
 * 若将来换成支持竖屏的模型，把这里接回 buildVideoPayload 即可。
 */
export const PORTRAIT_SIZE = {
  '480p': '480x854',
  '720p': '720x1280',
  '1080p': '1080x1920',
};

export const ENDPOINTS = {
  models: '/v1/models',
  // grok-imagine-image-2.0 走图片专用端点，不走聊天端点。
  // 2026-09-28 实测确认：/v1/chat/completions 一律返回 400。
  imageCreate: '/v1/images/generations',
  chat: '/v1/chat/completions',
  videoCreate: '/v1/videos',
  videoStatus: (taskId) => `/v1/videos/${encodeURIComponent(taskId)}`,
  videoContent: (taskId) => `/v1/videos/${encodeURIComponent(taskId)}/content`,
};

/** 构造视频创建请求体。 */
export function buildVideoPayload({
  model,
  prompt,
  referenceImages = [],
  seconds,
  resolution,
  orientation = 'landscape',
}) {
  // 本模型只出横屏。传 portrait 就直接报错，不要静默改成横屏——
  // 那样用户会拿到一个画幅不对的成片却不知道为什么。
  if (orientation !== 'landscape') {
    throw new ValidationError(
      `grok-imagine-video-1.5 只支持横屏 16:9，收到 orientation="${orientation}"。\n` +
        `    上游原话：Grok video size must be 1280x720 or 1920x1080。\n` +
        `    需要竖屏成片请改用支持竖屏的模型，或生成横屏后裁切（画质会明显下降）。`
    );
  }
  const size = LANDSCAPE_SIZE[resolution];
  if (!size) {
    throw new ValidationError(
      `未知或不支持的分辨率：${resolution}。本模型只支持 ${Object.keys(LANDSCAPE_SIZE).join(' / ')}。`
    );
  }

  const payload = {
    model,
    prompt,
    seconds: String(seconds), // 接口要字符串
    size,
    resolution,
  };
  if (referenceImages.length > 0) {
    payload.reference_images = referenceImages;
  }
  return payload;
}

/**
 * 构造图片生成请求体（OpenAI 图片格式）。
 *
 * 2026-09-28 实测：聊天格式（messages + stream）一律 400，
 * 必须用 { model, prompt, n } 走 /v1/images/generations。
 *
 * size 必须显式传。不传时画幅由模型从提示词里自己猜，会出错：
 * frame-01/02/03 用同一批提示词（都写了「16:9 横屏」），02 和 03 猜中
 * 1280x720，01 猜成了 1024x1024 —— 那张的构图是「眼睛横向占满画面」，
 * 极端横构图反而让模型倒向方形。首帧图画幅错了会被视频平台裁或拉伸，
 * 所以这里不能赌。
 */
export function buildImagePayload({ model, prompt, n = 1, size = '1280x720' }) {
  return { model, prompt, n, size };
}

/** 旧的聊天格式，保留备用 —— 心流若改回聊天端点时可切换。 */
export function buildImageChatPayload({ model, prompt }) {
  return {
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
  };
}

/** 从创建响应里取 task_id。 */
export function extractTaskId(response) {
  const id = response?.task_id ?? response?.id ?? response?.data?.task_id ?? null;
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : null;
}

/** 从状态响应里取状态字符串（统一成小写）。 */
export function extractStatus(response) {
  const raw =
    response?.status ?? response?.state ?? response?.data?.status ?? null;
  return typeof raw === 'string' ? raw.toLowerCase().trim() : null;
}

/** 状态归类。不同平台叫法不一，统一成三种结局。 */
const SUCCESS = new Set(['succeeded', 'success', 'completed', 'complete', 'done', 'finished']);
const FAILURE = new Set(['failed', 'failure', 'error', 'canceled', 'cancelled', 'rejected', 'expired']);
const PENDING = new Set(['pending', 'queued', 'waiting', 'processing', 'running', 'in_progress', 'started', 'submitted']);

export function classifyStatus(status) {
  if (!status) return 'unknown';
  if (SUCCESS.has(status)) return 'success';
  if (FAILURE.has(status)) return 'failure';
  if (PENDING.has(status)) return 'pending';
  return 'unknown';
}

/** 从状态响应里找视频 URL（成功后可能直接给链接）。 */
export function extractVideoUrl(response) {
  const candidates = [
    response?.video_url,
    response?.url,
    response?.output?.video_url,
    response?.output?.url,
    response?.data?.video_url,
    response?.data?.url,
    Array.isArray(response?.data) ? response.data[0]?.url : null,
    Array.isArray(response?.output) ? response.output[0] : null,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && /^https?:\/\//i.test(c)) return c;
  }
  return null;
}

/** 从状态响应里取错误说明。 */
export function extractError(response) {
  const e =
    response?.error?.message ??
    response?.error ??
    response?.message ??
    response?.fail_reason ??
    response?.failure_reason ??
    null;
  if (!e) return null;
  return typeof e === 'string' ? e : JSON.stringify(e);
}
