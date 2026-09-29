/**
 * 从图片模型的聊天式响应里提取图片 URL。
 *
 * 钱已经花了，所以这里的原则是「尽最大努力解析成功」：
 * 第三方返回格式不确定，可能是
 *   1. 纯 URL：           https://cdn.x.ai/abc.png
 *   2. Markdown 图片：    ![image](https://cdn.x.ai/abc.png)
 *   3. 夹在文字里：        好的，这是您要的图片：https://cdn.x.ai/abc.png 希望满意
 *   4. Markdown 链接：    [查看](https://cdn.x.ai/abc.png)
 *   5. HTML img 标签：    <img src="https://cdn.x.ai/abc.png">
 *   6. JSON 字符串片段：  {"url": "https://cdn.x.ai/abc.png"}
 *
 * 解析失败时必须抛出带原文的错误 —— 让用户能手动把 URL 抠出来，
 * 而不是丢掉一次已经付费的结果。
 */

/** 从聊天响应里取出 content 文本。 */
export function extractContent(response) {
  const candidates = [
    response?.choices?.[0]?.message?.content,
    response?.choices?.[0]?.delta?.content,
    response?.choices?.[0]?.text,
    response?.message?.content,
    response?.content,
    response?.data?.[0]?.url,
  ];

  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') return c;
    // 有些实现把 content 做成数组（多模态格式）
    if (Array.isArray(c)) {
      for (const part of c) {
        if (typeof part === 'string' && part.trim()) return part;
        const inner =
          part?.text ?? part?.image_url?.url ?? part?.url ?? part?.source?.url;
        if (typeof inner === 'string' && inner.trim()) return inner;
      }
    }
  }
  return null;
}

/** 图片扩展名白名单，用于在多个 URL 中挑出最像图片的那个。 */
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif)(\?|#|$)/i;

/**
 * 从任意文本里抽出所有 https URL。
 * 注意末尾清理：Markdown 的 `)`、中文标点、句号都不能算进 URL。
 */
export function findUrls(text) {
  if (typeof text !== 'string') return [];

  const raw = text.match(/https:\/\/[^\s<>"'`一-鿿]+/g) ?? [];

  return raw
    .map((u) => {
      let s = u;
      // 去掉 Markdown / HTML / 标点造成的尾巴。
      // ASCII 句点也要剥 —— 合法 URL 不会以 . 结尾，而中文语境里
      // "图片地址 https://x/a.png." 这种写法很常见。
      s = s.replace(/[)\]}>,;.。，、！？"'`]+$/g, '');
      // 括号配平：URL 里可能合法包含 ( )，只剥掉多出来的右括号
      let depth = 0;
      let cut = s.length;
      for (let i = 0; i < s.length; i++) {
        if (s[i] === '(') depth++;
        else if (s[i] === ')') {
          depth--;
          if (depth < 0) {
            cut = i;
            break;
          }
        }
      }
      return s.slice(0, cut);
    })
    .filter((s) => s.length > 'https://'.length)
    .filter((s) => {
      try {
        new URL(s);
        return true;
      } catch {
        return false;
      }
    });
}

export class ImageUrlParseError extends Error {
  constructor(message, rawContent, rawResponse) {
    super(message);
    this.name = 'ImageUrlParseError';
    this.rawContent = rawContent;
    this.rawResponse = rawResponse;
  }
}

/**
 * 结构化提取：/v1/images/generations 返回的是规整的
 * { created, data: [{ url }], usage } 结构，不需要正则去猜。
 * 这是首选路径；正则解析只作为聊天端点的兜底。
 */
export function extractStructuredUrls(response) {
  const data = response?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((d) => (typeof d === 'string' ? d : d?.url ?? d?.image_url ?? d?.b64_url))
    .filter((u) => typeof u === 'string' && /^https:\/\//i.test(u));
}

/**
 * 主解析入口。
 * @returns {{ url: string, all: string[], format: string, content: string }}
 */
export function parseImageUrl(response) {
  // 优先走结构化路径
  const structured = extractStructuredUrls(response);
  if (structured.length > 0) {
    return {
      url: structured[0],
      all: structured,
      format: 'images_api',
      content: JSON.stringify(response?.data ?? null),
    };
  }

  const content = extractContent(response);

  if (content === null) {
    throw new ImageUrlParseError(
      '响应里找不到 choices[0].message.content。图片可能已生成并扣费，' +
        '请到心流后台「使用日志」查看本次调用的原始返回，手动取出图片 URL。',
      null,
      response
    );
  }

  const urls = findUrls(content);

  if (urls.length === 0) {
    throw new ImageUrlParseError(
      '响应内容里没有找到任何 https URL。图片可能已生成并扣费，' +
        '请查看下面的原始内容，手动取出 URL 填进 shots.json。',
      content,
      response
    );
  }

  // 判断格式，便于日志里说明这次是哪种
  let format = 'plain_text';
  const trimmed = content.trim();
  if (/^https:\/\/\S+$/.test(trimmed)) format = 'bare_url';
  else if (/!\[[^\]]*\]\(https:\/\//.test(content)) format = 'markdown_image';
  else if (/\[[^\]]*\]\(https:\/\//.test(content)) format = 'markdown_link';
  else if (/<img[^>]+src=/i.test(content)) format = 'html_img';
  else if (/"url"\s*:/.test(content)) format = 'json_fragment';

  // 多个 URL 时，优先挑带图片扩展名的
  const withExt = urls.filter((u) => IMAGE_EXT.test(u));
  const url = withExt[0] ?? urls[0];

  return { url, all: urls, format, content };
}
