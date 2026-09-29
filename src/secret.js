/**
 * 密钥容器。
 *
 * 设计意图：密钥原文只能通过 reveal() 取出，而 reveal() 只在真正
 * 构造 HTTP 请求头的那一处调用。其余任何路径 —— toString、
 * JSON.stringify、console.log、模板字符串、报错堆栈 —— 拿到的都是
 * 掩码。这样即使某处代码不小心打印了整个 config 对象，也不会泄露。
 */

const RAW = Symbol('raw');

export class Secret {
  constructor(value, label = 'SECRET') {
    if (typeof value !== 'string') {
      throw new TypeError(`${label} 必须是字符串`);
    }
    Object.defineProperty(this, RAW, {
      value,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    this.label = label;
  }

  /** 取出原文。只允许在拼装请求头处调用。 */
  reveal() {
    return this[RAW];
  }

  get length() {
    return this[RAW].length;
  }

  isEmpty() {
    return this[RAW].trim() === '';
  }

  /** 掩码形式：保留前 3 位便于辨认是哪把钥匙，其余全遮。 */
  mask() {
    const v = this[RAW];
    if (v.trim() === '') return '(空)';
    const head = v.slice(0, 3);
    return `${head}${'*'.repeat(Math.max(4, Math.min(v.length - 3, 12)))}`;
  }

  toString() {
    return this.mask();
  }

  toJSON() {
    return this.mask();
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `Secret<${this.label}: ${this.mask()}>`;
  }
}

/**
 * 兜底清洗：把任意文本里出现的密钥原文替换成掩码。
 * 用于日志和报错信息 —— 上游返回的 error body 有时会回显请求头。
 */
export function scrub(text, secrets = []) {
  let out = typeof text === 'string' ? text : String(text);
  for (const s of secrets) {
    if (!(s instanceof Secret) || s.isEmpty()) continue;
    const raw = s.reveal();
    if (raw.length < 8) continue; // 太短的串全局替换风险大，跳过
    out = out.split(raw).join(s.mask());
  }
  // 再兜一层：常见密钥前缀 + 长串
  out = out.replace(/\b(sk|hf|ghp|xai)-[A-Za-z0-9_\-]{12,}/g, '$1-***');
  out = out.replace(/(Bearer\s+)[A-Za-z0-9_\-.]{12,}/gi, '$1***');
  return out;
}
