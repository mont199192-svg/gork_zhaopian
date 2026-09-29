/**
 * 参数校验。在花钱之前把所有能本地发现的错误全挡掉。
 */

/**
 * 视频走 lk888 gk-video-3.5，档位只有 720p 和 480p，没有 1080p。
 *
 * 成片要 1080p 的话是在剪辑阶段放大，不是在生成阶段拿到 —— 这个模型
 * 就不出 1080p。
 */
export const VALID_RESOLUTIONS = ['720p', '480p'];

/**
 * gk-video-3.5 支持 1~15 秒的任意整数秒。
 *
 * 这是换平台带来的最大变化。之前心流的 grok-imagine-video-1.5 只收 15 秒，
 * 不管镜头需要多长都得按 15 秒付钱再剪短；现在可以按剧本给每个镜头单独
 * 定时长，不浪费秒数。
 */
export const MIN_SECONDS = 1;
export const MAX_SECONDS = 15;

/**
 * gk-video-3.5 的 images 只收 1 张，而且是首帧参考图。
 *
 * 只有一张的额外含义：这张图决定视频的第一帧，所以它必须同时承载人物
 * 长相和场景环境。分开做「人物图 + 环境图 + 光线图」在这里没有意义。
 */
export const MAX_REFERENCE_IMAGES = 1;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** 时长：1~15 的整数秒。见 MIN_SECONDS / MAX_SECONDS 的说明。 */
export function validateSeconds(seconds) {
  const warnings = [];

  if (typeof seconds === 'string' && !/^\d+$/.test(seconds.trim())) {
    throw new ValidationError(`时长必须是整数，当前为 "${seconds}"`);
  }
  const n = Number(seconds);

  if (!Number.isFinite(n)) {
    throw new ValidationError(`时长不是有效数字：${seconds}`);
  }
  if (!Number.isInteger(n)) {
    throw new ValidationError(`时长必须是整数秒，不能是小数：${n}`);
  }
  if (n < MIN_SECONDS || n > MAX_SECONDS) {
    throw new ValidationError(
      `时长必须在 ${MIN_SECONDS}~${MAX_SECONDS} 秒之间，当前为 ${n}。\n` +
        `    gk-video-3.5 的上限是 ${MAX_SECONDS} 秒。更长的镜头请拆成两个。`
    );
  }
  // 按秒计费，长镜头直接反映在账单上，值得提醒一句
  if (n > 10) {
    warnings.push(`时长 ${n} 秒偏长，按秒计费，确认这个镜头确实需要这么久。`);
  }
  return { seconds: n, warnings };
}

/** 分辨率：只接受三档。 */
export function validateResolution(resolution) {
  if (typeof resolution !== 'string') {
    throw new ValidationError(`分辨率必须是字符串，当前为 ${typeof resolution}`);
  }
  const r = resolution.trim().toLowerCase();
  if (!VALID_RESOLUTIONS.includes(r)) {
    throw new ValidationError(
      `分辨率只支持 ${VALID_RESOLUTIONS.join(' / ')}，当前为 "${resolution}"`
    );
  }
  return r;
}

/** 提示词：非空，且长度合理。 */
export function validatePrompt(prompt, { field = 'prompt' } = {}) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new ValidationError(`${field} 不能为空`);
  }
  const p = prompt.trim();
  if (p.length > 4000) {
    throw new ValidationError(`${field} 过长（${p.length} 字），请压缩到 4000 字以内`);
  }
  return p;
}

/**
 * 参考图：必须是公网 HTTPS URL，最多 1 张（首帧图）。
 * 本地路径、data: base64、http:// 全部拒绝 —— 接口不接受。
 */
export function validateReferenceImages(images) {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images)) {
    throw new ValidationError('reference_images 必须是数组');
  }
  if (images.length > MAX_REFERENCE_IMAGES) {
    throw new ValidationError(
      `参考图最多 ${MAX_REFERENCE_IMAGES} 张，当前给了 ${images.length} 张。\n` +
        `    gk-video-3.5 的 images 只收 1 张，作为视频首帧。\n` +
        `    人物长相和场景环境要画在同一张图里，不能分成多张。`
    );
  }

  const out = [];
  images.forEach((url, i) => {
    const label = `第 ${i + 1} 张参考图`;
    if (typeof url !== 'string' || url.trim() === '') {
      throw new ValidationError(`${label}为空`);
    }
    const u = url.trim();
    if (u.startsWith('data:')) {
      throw new ValidationError(`${label}是 base64，接口只接受公网 HTTPS URL`);
    }
    if (/^[a-zA-Z]:[\\/]/.test(u) || u.startsWith('/') || u.startsWith('.')) {
      throw new ValidationError(`${label}是本地路径，接口只接受公网 HTTPS URL：${u}`);
    }
    if (u.startsWith('http://')) {
      throw new ValidationError(`${label}是 http，必须用 https：${u}`);
    }
    if (!u.startsWith('https://')) {
      throw new ValidationError(`${label}不是合法 HTTPS URL：${u}`);
    }
    try {
      new URL(u);
    } catch {
      throw new ValidationError(`${label} URL 格式不合法：${u}`);
    }
    out.push(u);
  });
  return out;
}

/** 单个镜头的完整校验。 */
export function validateShot(shot, index, defaults = {}) {
  const label = shot?.id ? `镜头 ${shot.id}` : `第 ${index + 1} 个镜头`;
  const warnings = [];

  if (!shot || typeof shot !== 'object') {
    throw new ValidationError(`${label} 不是有效对象`);
  }

  const id = typeof shot.id === 'string' && shot.id.trim() ? shot.id.trim() : `shot-${index + 1}`;

  let prompt;
  try {
    prompt = validatePrompt(shot.prompt, { field: `${label} 的 prompt` });
  } catch (e) {
    throw new ValidationError(e.message);
  }

  const sec = validateSeconds(shot.seconds ?? defaults.seconds ?? 6);
  warnings.push(...sec.warnings.map((w) => `${label}：${w}`));

  let resolution;
  try {
    resolution = validateResolution(shot.resolution ?? defaults.resolution ?? '720p');
  } catch (e) {
    throw new ValidationError(`${label}：${e.message}`);
  }

  let referenceImages;
  try {
    referenceImages = validateReferenceImages(shot.reference_images ?? shot.referenceImages);
  } catch (e) {
    throw new ValidationError(`${label}：${e.message}`);
  }

  const orientation = shot.orientation === 'landscape' ? 'landscape' : 'portrait';

  // firstFrame 指向 referenceImages 里某张图的 id，是这个镜头的首帧。
  // 这里只做「有没有填」的检查 —— 能不能对上要看整个项目的参考图列表，
  // 那是 genVideos 提交前解析首帧图时的事。
  const firstFrame =
    typeof shot.firstFrame === 'string' && shot.firstFrame.trim()
      ? shot.firstFrame.trim()
      : null;
  if (!firstFrame) {
    warnings.push(
      `${label} 没有 firstFrame 字段。gk-video-3.5 是图生视频模型，` +
        `每个镜头都需要一张首帧参考图，否则无法提交。`
    );
  }

  // editSeconds 是成片里实际保留的秒数，剪辑阶段用，生成阶段不看。
  const editSeconds =
    Number.isInteger(shot.editSeconds) && shot.editSeconds > 0 ? shot.editSeconds : null;

  return {
    shot: {
      id,
      prompt,
      seconds: sec.seconds,
      resolution,
      referenceImages,
      orientation,
      firstFrame,
      editSeconds,
    },
    warnings,
  };
}

/** 整份 shots.json 的校验。 */
export function validateShotList(shots, defaults = {}) {
  if (!Array.isArray(shots) || shots.length === 0) {
    throw new ValidationError('镜头列表为空');
  }

  const validated = [];
  const warnings = [];
  const seen = new Set();

  shots.forEach((s, i) => {
    const { shot, warnings: w } = validateShot(s, i, defaults);
    if (seen.has(shot.id)) {
      throw new ValidationError(`镜头 ID 重复：${shot.id}。每个镜头 ID 必须唯一，否则台账无法防重。`);
    }
    seen.add(shot.id);
    validated.push(shot);
    warnings.push(...w);
  });

  return { shots: validated, warnings };
}
