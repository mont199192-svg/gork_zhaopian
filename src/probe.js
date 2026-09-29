#!/usr/bin/env node
/**
 * 图片接口探针。node src/probe.js
 *
 * 心流的 400 只透传 "Upstream error: 400"，不说哪个参数错，
 * 后台日志也只有 "status_code=400"。所以只能试。
 *
 * 关键前提：从心流使用日志确认，失败的调用花费为 ⚡0.00。
 * 也就是说 —— 400 不扣钱，只有成功出图才扣 0.04 元。
 * 因此可以连续试多种变体，一旦成功立刻停止。
 * 最大花费 = 0.04 元（第一次成功的那次）。
 *
 * 探针按「最可能」到「最不可能」排序，逐个试，成功即停。
 */

import { loadConfig, authHeaders } from './config.js';
import { log, registerSecrets } from './logger.js';
import { requireConfirmation, ConfirmationDeclined } from './confirm.js';
import { parseImageUrl } from './parseImageUrl.js';

const SHORT_CN = '一只橘色的猫坐在窗台上';
const SHORT_EN = 'an orange cat sitting on a windowsill';

/**
 * 探针清单。每一项测一个假设。
 */
function buildProbes(config) {
  const M = config.imageModel;

  return [
    {
      name: '短中文提示词 + stream:false',
      hypothesis: '原提示词过长或含写实人像描写被拒',
      path: '/v1/chat/completions',
      body: { model: M, messages: [{ role: 'user', content: SHORT_CN }], stream: false },
    },
    {
      name: '短中文提示词，不带 stream 字段',
      hypothesis: 'stream 字段本身不被接受',
      path: '/v1/chat/completions',
      body: { model: M, messages: [{ role: 'user', content: SHORT_CN }] },
    },
    {
      name: '短英文提示词',
      hypothesis: '上游对中文提示词处理有问题',
      path: '/v1/chat/completions',
      body: { model: M, messages: [{ role: 'user', content: SHORT_EN }], stream: false },
    },
    {
      name: '带 system 消息',
      hypothesis: '需要 system 角色开头',
      path: '/v1/chat/completions',
      body: {
        model: M,
        messages: [
          { role: 'system', content: 'You are an image generator.' },
          { role: 'user', content: SHORT_EN },
        ],
        stream: false,
      },
    },
    {
      name: '改用 /v1/images/generations 端点',
      hypothesis: '这个模型走图片专用端点，不走聊天端点',
      path: '/v1/images/generations',
      body: { model: M, prompt: SHORT_EN, n: 1 },
    },
    {
      name: '/v1/images/generations + size',
      hypothesis: '图片端点且需要 size',
      path: '/v1/images/generations',
      body: { model: M, prompt: SHORT_EN, n: 1, size: '1024x1792' },
    },
  ];
}

async function runProbe(config, probe, index, total) {
  log.plain('');
  log.plain(`[${index + 1}/${total}] ${probe.name}`);
  log.plain(`      假设：${probe.hypothesis}`);
  log.plain(`      POST ${probe.path}`);
  log.plain(`      ${JSON.stringify(probe.body).slice(0, 160)}`);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 180_000);

  try {
    const res = await fetch(config.baseUrl + probe.path, {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify(probe.body),
      signal: ctl.signal,
    });

    const text = await res.text().catch(() => '');
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* 保持文本 */
    }

    if (!res.ok) {
      const brief =
        typeof parsed === 'object'
          ? (parsed?.error?.message ?? JSON.stringify(parsed)).slice(0, 200)
          : String(parsed).slice(0, 200);
      log.plain(`      ✖ HTTP ${res.status} — ${brief}`);
      return { ok: false, status: res.status, body: parsed };
    }

    log.plain(`      ✓ HTTP ${res.status}`);
    return { ok: true, status: res.status, body: parsed };
  } catch (err) {
    log.plain(`      ✖ 网络异常 — ${err.message}`);
    return { ok: false, status: null, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    log.error(e.message);
    process.exitCode = 1;
    return;
  }
  registerSecrets([config.apiKey, config.lk888Key]);

  const probes = buildProbes(config);

  log.plain('');
  log.plain('─'.repeat(64));
  log.plain('  图片接口探针');
  log.plain('─'.repeat(64));
  log.plain('');
  log.plain(`  模型：${config.imageModel}`);
  log.plain(`  变体数：${probes.length}`);
  log.plain('');
  log.plain('  费用说明：');
  log.plain('    已从心流使用日志确认，400 失败的调用花费为 0.00 元。');
  log.plain('    因此只有「成功出图」的那一次会扣费。');
  log.plain('    探针一旦成功立刻停止，所以最大花费 = 0.04 元。');
  log.plain('');
  log.plain('─'.repeat(64));

  try {
    await requireConfirmation({
      prompt: '\n请输入「确认生成」开始探测（最大花费 0.04 元）：',
    });
  } catch (e) {
    if (e instanceof ConfirmationDeclined) {
      log.plain('');
      log.plain(e.message);
      return;
    }
    throw e;
  }

  const results = [];
  let winner = null;

  for (let i = 0; i < probes.length; i++) {
    const r = await runProbe(config, probes[i], i, probes.length);
    results.push({ probe: probes[i], result: r });

    if (r.ok) {
      winner = { probe: probes[i], result: r };
      log.plain('');
      log.ok('成功，停止探测。');
      break;
    }

    // 失败不花钱，但别把上游打太急
    if (i < probes.length - 1) await new Promise((r) => setTimeout(r, 2000));
  }

  log.plain('');
  log.plain('═'.repeat(64));

  if (!winner) {
    log.plain('  全部变体都失败了。');
    log.plain('');
    log.plain('  状态码汇总：');
    for (const { probe, result } of results) {
      log.plain(`    ${String(result.status ?? '网络错误').padEnd(6)} ${probe.name}`);
    }
    log.plain('');
    log.plain('  本次未产生费用（全部失败）。');
    log.plain('');
    log.plain('  下一步建议：');
    log.plain('    1. 到心流后台「接口文档」确认这个模型的调用示例');
    log.plain('    2. 或在后台「操练场」手动试一次，看它实际发什么请求');
    log.plain('    3. 或联系心流客服，问 grok-imagine-image-2.0 在 low 分组的正确调法');
    log.plain('═'.repeat(64));
    process.exitCode = 1;
    return;
  }

  // ---- 成功：把返回结构摸清楚 ----
  log.plain('  可用的调用方式：');
  log.plain('');
  log.plain(`    端点：POST ${winner.probe.path}`);
  log.plain(`    请求体：`);
  log.plain(JSON.stringify(winner.probe.body, null, 6).split('\n').map((l) => '    ' + l).join('\n'));
  log.plain('');
  log.plain('  返回结构：');
  const bodyStr = JSON.stringify(winner.result.body, null, 2);
  log.plain(bodyStr.slice(0, 2000).split('\n').map((l) => '    ' + l).join('\n'));
  if (bodyStr.length > 2000) log.plain('    …（已截断）');
  log.plain('');

  // 试试现有解析器认不认
  try {
    const p = parseImageUrl(winner.result.body);
    log.ok(`URL 解析成功，格式：${p.format}`);
    log.plain(`    ${p.url}`);
    if (p.all.length > 1) {
      log.plain(`    （响应里共 ${p.all.length} 个 URL）`);
    }
  } catch (e) {
    log.warn(`现有解析器没认出 URL：${e.message}`);
    log.plain('    需要按上面的返回结构调整 parseImageUrl.js');
  }

  log.plain('');
  log.plain('  本次花费：0.04 元（仅成功的那一次）');
  log.plain('═'.repeat(64));
  log.plain('');
}

main().catch((e) => {
  log.error(`未预期的错误：${e?.message ?? e}`);
  process.exitCode = 1;
});
