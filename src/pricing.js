/**
 * 费用计算。
 *
 * 人民币 = 平台额度 × rechargeRatio
 * 图片：张数 × imagePerCall × ratio
 * 视频：秒数 × 对应档位单价 × ratio
 *
 * 所有金额一律保留 2 位小数（分），但累加时用原始值，避免逐项四舍五入误差。
 */

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function cny(credits, ratio) {
  return credits * ratio;
}

export function fmt(n) {
  return `${round2(n).toFixed(2)} 元`;
}

/** 图片报价。 */
export function quoteImages(count, config) {
  const { imagePerCall, rechargeRatio } = config.price;
  const credits = count * imagePerCall;
  return {
    kind: 'image',
    count,
    model: config.imageModel,
    unitCredits: imagePerCall,
    unitCny: cny(imagePerCall, rechargeRatio),
    totalCredits: credits,
    totalCny: cny(credits, rechargeRatio),
  };
}

/**
 * 单个视频镜头报价。
 *
 * lk888 的单价本来就是人民币/秒，不走 rechargeRatio 换算 —— 这点和图片
 * 不一样，别顺手乘上比例，会把价格算成两倍多。
 */
export function quoteShot(shot, config) {
  const perSec = config.price.videoPerSecondCny[shot.resolution];
  if (perSec === undefined) {
    throw new Error(
      `没有 ${shot.resolution} 的价格配置。gk-video-3.5 只有 720p / 480p。`
    );
  }
  return {
    id: shot.id,
    seconds: shot.seconds,
    resolution: shot.resolution,
    perSecondCny: perSec,
    totalCny: shot.seconds * perSec,
  };
}

/** 一批视频报价。 */
export function quoteVideos(shots, config) {
  const items = shots.map((s) => quoteShot(s, config));
  return {
    kind: 'video',
    model: config.videoModel,
    count: items.length,
    items,
    totalSeconds: items.reduce((a, b) => a + b.seconds, 0),
    totalCny: items.reduce((a, b) => a + b.totalCny, 0),
  };
}

/**
 * 合并报价。
 *
 * 图片（心流）按额度计价再换算成人民币，视频（lk888）直接就是人民币，
 * 所以这里只在人民币这一层相加，不再有一个跨平台的「总额度」。
 */
export function quoteBatch({ images = 0, shots = [] }, config) {
  const imageQuote = images > 0 ? quoteImages(images, config) : null;
  const videoQuote = shots.length > 0 ? quoteVideos(shots, config) : null;

  const totalCny = (imageQuote?.totalCny ?? 0) + (videoQuote?.totalCny ?? 0);
  const overLimit = round2(totalCny) > config.maxSpendPerBatchCny;

  return {
    imageQuote,
    videoQuote,
    totalCny,
    limitCny: config.maxSpendPerBatchCny,
    overLimit,
  };
}

/** 渲染成给人看的明细表。 */
export function renderQuote(quote, config) {
  const L = [];
  const line = '─'.repeat(64);

  L.push(line);
  L.push('  预计费用明细（提交前估算）');
  L.push(line);

  if (quote.imageQuote) {
    const q = quote.imageQuote;
    L.push('');
    L.push(`  参考图  心流 ${q.model}`);
    L.push(`          ${q.count} 张 × ${fmt(q.unitCny)}/张 = ${fmt(q.totalCny)}`);
    L.push(
      `          （平台额度 ${round2(q.totalCredits).toFixed(3)}，换算比例 1 额度 = ${config.price.rechargeRatio} 元）`
    );
  }

  if (quote.videoQuote) {
    const q = quote.videoQuote;
    L.push('');
    L.push(`  视频    lk888 ${q.model}`);
    L.push('');
    L.push('   镜头ID              时长   分辨率    单价/秒     小计');
    L.push('   ' + '-'.repeat(58));
    for (const it of q.items) {
      const id = String(it.id).padEnd(18);
      const sec = `${it.seconds}s`.padStart(4);
      const res = String(it.resolution).padStart(7);
      const per = fmt(it.perSecondCny).padStart(10);
      const sub = fmt(it.totalCny).padStart(10);
      L.push(`   ${id}${sec}  ${res}  ${per}  ${sub}`);
    }
    L.push('   ' + '-'.repeat(58));
    L.push(
      `   合计 ${q.count} 个镜头，共 ${q.totalSeconds} 秒` +
        `${' '.repeat(12)}${fmt(q.totalCny).padStart(10)}`
    );
  }

  L.push('');
  L.push(line);
  L.push(`  预计总费用：${fmt(quote.totalCny)}`);
  L.push(`  视频按实际时长结算，实际出片短于请求时长时会少扣；失败任务自动退款。`);
  L.push(`  这里是上限估算，最终以两个平台各自的使用日志为准。`);
  L.push(line);

  if (quote.overLimit) {
    L.push('');
    L.push(`  ✖ 超出单批上限 ${fmt(quote.limitCny)}，已中止。`);
    L.push(`    如确需提交，请调高 .env 里的 MAX_SPEND_PER_BATCH_CNY。`);
    L.push(line);
  }

  return L.join('\n');
}
