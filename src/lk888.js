/**
 * lk888（gk-video-3.5）接口字段映射。
 *
 * 为什么另开一个文件而不改 fieldMap.js：
 * 图片生成还留在心流（grok-imagine-image-2.0），视频换到这里。
 * 两套端点、两套鉴权、两套字段名并存，混在一个文件里迟早会串。
 *
 * 与心流 grok-imagine-video-1.5 的关键差异：
 *   1. 请求体是三层 {model, prompt, params:{...}}，参数不在顶层
 *   2. 时长字段叫 duration（字符串，"1"~"15"），不叫 seconds
 *   3. 画幅用 aspect_ratio（"16:9"/"9:16"/...），不是 size 像素串
 *   4. 参考图字段叫 images，最多 1 张，是「首帧参考图」不是风格参考
 *   5. 状态查询走 query string：GET /v1/media/status?task_id=
 *   6. 终态判定用 is_final（布尔），成功失败用 state
 *   7. 失败自动退款 —— state==='failed' 不扣费，这比心流干净
 */

export const ENDPOINTS = {
  videoCreate: '/v1/media/generate',
  videoStatus: (taskId) => `/v1/media/status?task_id=${encodeURIComponent(taskId)}`,
};

/** duration 支持 1~15 的整数，按秒计费。 */
export const MIN_DURATION = 1;
export const MAX_DURATION = 15;

/** aspect_ratio 的 5 个合法值。 */
export const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '3:2', '2:3'];

/** resolution 只有两档，没有 1080p。 */
export const RESOLUTIONS = ['720p', '480p'];

/** images 最多 1 张 —— 模型只做图生视频，这张图是视频首帧。 */
export const MAX_IMAGES = 1;

export class Lk888FieldError extends Error {
  constructor(message) {
    super(message);
    this.name = 'Lk888FieldError';
  }
}

/**
 * 构造视频创建请求体。
 *
 * @param {object}   o
 * @param {string}   o.model        模型名，如 gk-video-3.5
 * @param {string}   o.prompt       画面动作与运镜描述
 * @param {string[]} o.images       首帧参考图，公网 URL 或 data URI，必填且只能 1 张
 * @param {number}   o.seconds      时长 1~15（内部统一叫 seconds，这里转成 duration）
 * @param {string}   o.resolution   720p / 480p
 * @param {string}   o.aspectRatio  16:9 / 9:16 / 1:1 / 3:2 / 2:3
 * @param {string}  [o.notifyUrl]   webhook，顶层字段，不放 params
 */
export function buildVideoPayload({
  model,
  prompt,
  images = [],
  seconds,
  resolution,
  aspectRatio,
  notifyUrl,
}) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new Lk888FieldError('prompt 不能为空');
  }

  // 图生视频专用模型：没有首帧图就没法生成，本地先挡掉，别浪费一次请求
  if (!Array.isArray(images) || images.length === 0) {
    throw new Lk888FieldError(
      'gk-video-3.5 只支持图生视频，必须提供 1 张首帧参考图。\n' +
        '    这张图会成为视频的第一帧，所以它的构图应该就是镜头的开场画面。'
    );
  }
  if (images.length > MAX_IMAGES) {
    throw new Lk888FieldError(
      `images 最多 ${MAX_IMAGES} 张，收到 ${images.length} 张。\n` +
        '    本模型只取一张首帧图，多传的不会被使用。'
    );
  }

  const n = Number(seconds);
  if (!Number.isInteger(n) || n < MIN_DURATION || n > MAX_DURATION) {
    throw new Lk888FieldError(
      `时长必须是 ${MIN_DURATION}~${MAX_DURATION} 的整数，收到 ${seconds}`
    );
  }

  if (!ASPECT_RATIOS.includes(aspectRatio)) {
    throw new Lk888FieldError(
      `aspect_ratio 只支持 ${ASPECT_RATIOS.join(' / ')}，收到 "${aspectRatio}"`
    );
  }

  if (!RESOLUTIONS.includes(resolution)) {
    throw new Lk888FieldError(
      `resolution 只支持 ${RESOLUTIONS.join(' / ')}，收到 "${resolution}"。\n` +
        '    注意本模型没有 1080p 档。'
    );
  }

  const payload = {
    model,
    prompt: prompt.trim(),
    params: {
      images,
      duration: String(n), // 文档示例是字符串 "6"
      aspect_ratio: aspectRatio,
      resolution,
    },
  };

  // notify_url 是顶层字段，与 model/prompt/params 平级。放进 params 会被忽略。
  if (notifyUrl) payload.notify_url = notifyUrl;

  return payload;
}

/** 创建响应里取 task_id。文档示例是数字，统一转成字符串存台账。 */
export function extractTaskId(response) {
  const id = response?.task_id ?? response?.data?.task_id ?? response?.id;
  if (id === undefined || id === null || id === '') return null;
  return String(id);
}

/**
 * 判定任务终态。
 *
 * 只认 is_final + state 这两个字段 —— status / status_group 是中文展示字段
 * （「已完成」「处理中」），文档明确说不要用来写判断逻辑。
 *
 * @returns {'success'|'failure'|'pending'|'unknown'}
 */
export function classifyTask(response) {
  const state = response?.state ?? response?.data?.state;
  const isFinal = response?.is_final ?? response?.data?.is_final;

  if (state === 'success') return 'success';
  if (state === 'failed') return 'failure';
  if (state === 'pending' || state === 'running') return 'pending';

  // state 读不懂但 is_final 明确为 true：按失败处理，别无限轮下去
  if (isFinal === true) return 'failure';
  if (isFinal === false) return 'pending';
  return 'unknown';
}

/** 成片地址。 */
export function extractVideoUrl(response) {
  const u = response?.result_url ?? response?.data?.result_url;
  return typeof u === 'string' && u.trim() !== '' ? u : null;
}

/** 失败原因。 */
export function extractError(response) {
  const e = response?.error ?? response?.data?.error;
  if (typeof e === 'string' && e.trim() !== '') return e;
  if (e && typeof e === 'object') return JSON.stringify(e);
  return null;
}

/** 进度百分比，纯展示用，可能没有。 */
export function extractProgress(response) {
  const p = response?.progress ?? response?.data?.progress;
  return typeof p === 'string' && p.trim() !== '' ? p : null;
}

/** 平台回报的实际花费，用于对账。 */
export function extractCost(response) {
  const c = response?.cost ?? response?.data?.cost;
  return typeof c === 'number' ? c : null;
}
