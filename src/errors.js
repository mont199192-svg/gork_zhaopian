/**
 * 错误分类。决定「能不能重试」这唯一一件事。
 *
 * 核心区分：
 *   fatal      —— 改参数/改密钥/充值之前，重试毫无意义
 *   moderation —— 内容审核拒绝，必须改提示词并重新获得用户确认
 *   transient  —— 临时故障，GET 可退避重试，POST 一律不自动重试
 *   unknown    —— 不确定，按 fatal 处理（保守）
 *
 * 全局原则：POST（创建图片/视频）默认 0 次自动重试，无论什么错。
 *           只有 GET（查询/下载）允许重试，最多 3 次，间隔 5/10/20 秒。
 */

export const RETRY_DELAYS_MS = [5000, 10000, 20000];
export const MAX_GET_RETRIES = 3;

export class ApiError extends Error {
  constructor({ status, body, url, method, category, hint }) {
    super(ApiError.buildMessage({ status, category, body, hint }));
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.url = url;
    this.method = method;
    this.category = category;
    this.hint = hint;
  }

  static buildMessage({ status, category, body, hint }) {
    const brief =
      typeof body === 'string'
        ? body.slice(0, 300)
        : JSON.stringify(body ?? {}).slice(0, 300);
    return `HTTP ${status ?? '?'} [${category}] ${hint ?? ''}\n    上游返回：${brief}`;
  }

  get retriable() {
    return this.category === 'transient';
  }
}

/** 从响应体里挖出错误文本，用于关键词匹配。 */
function bodyText(body) {
  if (body == null) return '';
  if (typeof body === 'string') return body.toLowerCase();
  try {
    return JSON.stringify(body).toLowerCase();
  } catch {
    return String(body).toLowerCase();
  }
}

const MODERATION_KEYWORDS = [
  'moderation_blocked',
  'content_policy',
  'content policy',
  'safety',
  'violat',
  '审核',
  '违规',
  '敏感',
  'blocked',
  'rejected by',
  'inappropriate',
];

export function looksLikeModeration(body) {
  const t = bodyText(body);
  return MODERATION_KEYWORDS.some((k) => t.includes(k));
}

/**
 * 从响应体里挖出上游真实状态码。
 *
 * 心流在把上游错误转给我们时，会换上自己的 HTTP 码（实测 xAI 422 → 心流 502），
 * 真实码只出现在正文里，形如：
 *   status_code=422, {"error":{"message":"xAI 服务返回状态码 422","type":"upstream_error"}}
 *
 * 返回 null 表示正文里没有可识别的上游码，按外层状态码处理即可。
 */
export function extractUpstreamStatus(body) {
  const t = bodyText(body);
  // 优先取 status_code=NNN，这是心流最稳定的一种写法
  let m = /status_code\s*=\s*(\d{3})/i.exec(t);
  if (m) return Number(m[1]);
  // 退一步匹配中文描述里的码
  m = /返回状态码\s*(\d{3})/.exec(t);
  if (m) return Number(m[1]);
  return null;
}

/**
 * 按 HTTP 状态码 + 响应体分类。
 */
export function classifyHttpError(status, body) {
  // 内容审核可能挂在 400 或 200 下，优先判断
  if (looksLikeModeration(body)) {
    return {
      category: 'moderation',
      hint:
        '内容审核拒绝。禁止用同样的提示词或参考图重试 —— 会再次扣费且再次被拒。\n' +
        '    请修改提示词或更换参考图，然后重新走一遍费用确认。',
    };
  }

  // 心流会把 xAI 的错误状态码包进自己的 5xx 里，正文形如
  //   status_code=422, {"error":{"message":"xAI 服务返回状态码 422","type":"upstream_error"}}
  // 直接按外层 502 判成 transient 会误导用户去「稍后重试」，
  // 而 4xx 级的上游拒绝重试多少次都一样。这里把真实码挖出来重判。
  const inner = extractUpstreamStatus(body);
  if (inner !== null && inner >= 400 && inner < 500 && inner !== 429) {
    return {
      category: 'fatal',
      hint:
        `上游（xAI）返回 ${inner}，心流把它包装成了 HTTP ${status}。\n` +
        '    这不是临时故障，重试不会变好 —— 必须改请求内容。\n' +
        (inner === 422
          ? '    422 = 参数格式合法但内容无法处理。按可能性排查：\n' +
            '      1. 参考图 xAI 侧拉不到（对我们可访问 ≠ 对 xAI 可访问）\n' +
            '      2. 参考图数量超出上游允许（试着只传 1 张）\n' +
            '      3. 提示词涉及真实人物肖像，被上游策略拒绝\n' +
            '    建议逐项二分排查，每次只改一个变量。\n'
          : '') +
        '    注意：上游 4xx 通常不扣费，但请以心流使用日志为准。',
    };
  }

  switch (status) {
    case 400:
      return {
        category: 'fatal',
        hint:
          '请求参数错误。请先改参数，不要重提。\n' +
          '    视频常见原因：时长不是 10 或 15（上游只认这两档）、分辨率写法不对、\n' +
          '      参考图 URL 公网不可访问。\n' +
          '    图片常见原因：端点或字段不对、提示词被上游拒绝。\n' +
          '    注意：4xx 表示任务从未创建，这次不会扣费。',
      };
    case 401:
      return {
        category: 'fatal',
        hint:
          '鉴权失败。.env 里的 XINLIU_MEDIA_API_KEY 缺失、写错或已失效。\n' +
          '    请到心流后台确认密钥，不要重试。',
      };
    case 402:
      return {
        category: 'fatal',
        hint: '余额不足或预扣费失败。请先到心流后台充值，不要重试。',
      };
    case 403:
      return {
        category: 'fatal',
        hint:
          '无权限。当前令牌分组（low）可能没有该模型的调用权限。\n' +
          '    请先跑 npm run check 确认模型可用，或到后台调整密钥分组。',
      };
    case 404:
      return {
        category: 'fatal',
        hint:
          '模型或任务不存在。若是创建请求，说明 low 分组没有该模型 —— \n' +
          '    先跑 npm run check。若是查询请求，说明 task_id 不对。',
      };
    case 429:
      return {
        category: 'rate_limit',
        hint:
          '并发或频率过高。GET 查询可等待后重试；\n' +
          '    创建任务（POST）不会自动重试 —— 请稍后手动再来，避免重复扣费。',
      };
    case 500:
    case 502:
    case 503:
    case 504:
      return {
        category: 'transient',
        hint:
          '服务器或上游临时异常。GET 查询与下载会指数退避重试；\n' +
          '    创建任务不会自动重试。',
      };
    default:
      if (status >= 500) {
        return { category: 'transient', hint: '服务端异常，GET 可重试。' };
      }
      if (status >= 400) {
        return {
          category: 'fatal',
          hint: `未预期的客户端错误 ${status}。保守处理为不可重试，请人工检查。`,
        };
      }
      return { category: 'unknown', hint: `未预期的状态码 ${status}。` };
  }
}

/** 网络层异常（超时、连接中断）分类。 */
export function classifyNetworkError(err) {
  const code = err?.cause?.code ?? err?.code ?? '';
  const msg = String(err?.message ?? '').toLowerCase();

  const transientCodes = [
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
  ];

  const isTransient =
    transientCodes.includes(code) ||
    msg.includes('timeout') ||
    msg.includes('fetch failed') ||
    msg.includes('aborted') ||
    msg.includes('socket hang up');

  return {
    category: isTransient ? 'transient' : 'unknown',
    code,
    hint: isTransient
      ? '网络超时或连接中断。GET 查询与下载会重试；创建任务不会 —— ' +
        '若创建请求中断且无法确认是否成功，必须先查台账和心流使用日志。'
      : '未知网络异常，保守处理为不可重试。',
  };
}

/** POST 创建请求专用：任何错误都不自动重试，只给清晰的下一步建议。 */
export function describeCreateFailure(err) {
  const lines = ['创建任务失败。按规则不会自动重试，以免重复扣费。', ''];

  if (err instanceof ApiError) {
    lines.push(`  状态码：${err.status}`);
    lines.push(`  分类：${err.category}`);
    if (err.hint) lines.push(`  说明：${err.hint}`);
    if (err.category === 'moderation') {
      lines.push('');
      lines.push('  下一步：修改提示词或参考图 → 重新运行 → 重新确认费用。');
    } else if (err.category === 'fatal') {
      lines.push('');
      lines.push('  下一步：按上面说明修正后，再重新运行。');
    } else {
      lines.push('');
      lines.push('  下一步：稍后手动重跑。重跑前请先查看台账，确认这次是否已扣费。');
    }
  } else {
    const net = classifyNetworkError(err);
    lines.push(`  网络异常：${net.code || err?.message}`);
    lines.push(`  说明：${net.hint}`);
    lines.push('');
    lines.push('  ⚠ 请求可能已到达服务器。重跑之前，务必到心流后台');
    lines.push('    「使用日志」确认这笔任务是否已经创建并扣费。');
  }

  return lines.join('\n');
}
