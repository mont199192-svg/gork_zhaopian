/**
 * 生成 ASS 字幕文件。
 *
 * 为什么用 ASS 而不是 SRT：SRT 只有文字和时间，样式全靠播放器猜。
 * ASS 把字体、字号、位置、底框都写进文件，ffmpeg 的 subtitles 滤镜
 * 用 libass 渲染，出来的效果和我们写的完全一致。
 *
 * 字幕是烧进画面的（hardsub），因为成片要能在任何地方直接播。
 */

/** 秒 → ASS 时间戳 h:mm:ss.cc（百分之一秒，不是毫秒）。 */
export function assTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const ss = Math.floor(rest);
  const cs = Math.round((rest - ss) * 100);
  // 四舍五入可能把 99.6 推到 100，要进位
  if (cs === 100) {
    return assTime(Math.floor(s) + 1);
  }
  return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/**
 * ASS 的 Dialogue 文本里这几个字符有特殊含义，必须转义。
 * 换行用 \N（大写，硬换行）。
 */
export function escapeAssText(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N');
}

/** 不透明度 0..1 → ASS 的 &HAABBGGRR 里的 AA（00 不透明，FF 全透明）。 */
function alphaHex(opacity) {
  const o = Math.min(1, Math.max(0, Number(opacity) || 0));
  const a = Math.round((1 - o) * 255);
  return String(a).length ? a.toString(16).toUpperCase().padStart(2, '0') : '00';
}

const DEFAULT_STYLE = {
  fontName: 'Microsoft YaHei',
  fontSize: 42,
  primaryColour: '&H00FFFFFF',
  outlineColour: '&H00000000',
  outline: 2,
  shadow: 1,
  // borderStyle: 1 = 描边+阴影（文字浮在画面上，无底框）
  //              4 = 半透明底框（文字后面有一块色块）
  borderStyle: 1,
  boxOpacity: 0.55,
  marginBottom: 56,
};

/**
 * 生成完整的 ASS 文件内容。
 *
 * @param cues  [{ startSec, endSec, text }]  已经是全片绝对时间
 * @param opts  { width, height, style }
 */
export function buildAss(cues, { width, height, style = {} } = {}) {
  const st = { ...DEFAULT_STYLE, ...style };

  // BorderStyle=1 是描边+阴影，文字直接浮在画面上，没有底框；
  // BorderStyle=4 是半透明底框，文字后面垫一块色块。
  const borderStyle = st.borderStyle === 4 ? 4 : 1;

  // 底框模式下颜色的透明度由 boxOpacity 决定，所以要重新拼颜色值。
  // 描边模式下用 outlineColour 原值（通常是不透明纯黑）。
  const boxColour =
    borderStyle === 4 ? `&H${alphaHex(st.boxOpacity)}000000` : st.outlineColour;

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    [
      'Style: Main',
      st.fontName,
      st.fontSize,
      st.primaryColour,
      '&H000000FF',
      boxColour,
      boxColour,
      '0', '0', '0', '0',
      '100', '100',
      '0', '0',
      String(borderStyle),
      String(st.outline ?? 0),
      String(st.shadow ?? 0),
      '2',                       // Alignment: 2 = 底部居中
      '40', '40',
      String(st.marginBottom ?? 56),
      '1',
    ].join(','),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const lines = cues.map((c) => {
    // 淡入淡出 0.2 秒，字幕硬切上下会很生硬
    const fade = '{\\fad(200,200)}';
    return [
      'Dialogue: 0',
      assTime(c.startSec),
      assTime(c.endSec),
      'Main',
      '',
      '0', '0', '0',
      '',
      fade + escapeAssText(c.text),
    ].join(',');
  });

  return header.concat(lines).join('\n') + '\n';
}

/**
 * 把 subtitles.json 里「相对镜头」的时间换算成全片绝对时间。
 *
 * @param cues      [{ shot, start, end, text }]
 * @param offsets   Map<shotId, { startSec, durationSec }>
 * @returns { cues: [{startSec,endSec,text}], warnings: [] }
 */
export function resolveCueTimes(cues, offsets) {
  const out = [];
  const warnings = [];

  for (const [i, c] of cues.entries()) {
    const label = `第 ${i + 1} 条字幕`;
    const text = typeof c.text === 'string' ? c.text.trim() : '';
    if (!text) {
      warnings.push(`${label} 没有文字，已跳过。`);
      continue;
    }

    const off = offsets.get(c.shot);
    if (!off) {
      warnings.push(`${label} 指向的镜头 "${c.shot}" 不在片子里，已跳过。`);
      continue;
    }

    const start = Number(c.start);
    const end = Number(c.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      warnings.push(`${label} 的 start/end 不合法（${c.start} → ${c.end}），已跳过。`);
      continue;
    }

    // 超出镜头长度就截断，别让字幕飘到下一个镜头上
    let clipped = end;
    if (end > off.durationSec) {
      clipped = off.durationSec;
      warnings.push(
        `${label} 的结束时间 ${end}s 超过 ${c.shot} 的时长 ${off.durationSec.toFixed(2)}s，已截断。`
      );
    }
    if (start >= off.durationSec) {
      warnings.push(`${label} 的开始时间 ${start}s 已超出 ${c.shot} 的时长，已跳过。`);
      continue;
    }

    out.push({
      startSec: off.startSec + start,
      endSec: off.startSec + clipped,
      text,
      shot: c.shot,
    });
  }

  out.sort((a, b) => a.startSec - b.startSec);

  // 相邻字幕重叠会同时显示，叠在一起看不清
  for (let i = 1; i < out.length; i++) {
    if (out[i].startSec < out[i - 1].endSec) {
      warnings.push(
        `字幕「${out[i - 1].text}」和「${out[i].text}」时间重叠，会同时出现在画面上。`
      );
    }
  }

  return { cues: out, warnings };
}
