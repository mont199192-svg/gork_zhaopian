#!/usr/bin/env node
/**
 * 权限自检。npm run check
 *
 * 只调用免费的 GET /v1/models，不产生任何生成费用。
 * 确认三件事：密钥有效、图片模型可用、视频模型可用。
 */

import { loadConfig } from './config.js';
import { log, registerSecrets } from './logger.js';
import { listModels } from './http.js';
import { ApiError } from './errors.js';

async function main() {
  log.plain('');
  log.plain('心流媒体 API 自检');
  log.plain('─'.repeat(64));

  let config;
  try {
    config = loadConfig();
  } catch (e) {
    log.error(e.message);
    process.exitCode = 1;
    return;
  }
  registerSecrets([config.apiKey, config.lk888Key]);

  log.plain(`  接口地址：${config.baseUrl}`);
  log.plain(`  密钥：${config.apiKey.mask()}（长度 ${config.apiKey.length}）`);
  log.plain(`  图片模型：${config.imageModel}`);
  log.plain(`  视频模型：${config.videoModel}`);
  log.plain(`  并发：视频 ${config.videoConcurrency} / 图片 ${config.imageConcurrency}`);
  log.plain(`  轮询间隔：${config.pollIntervalSeconds} 秒`);
  log.plain(`  单批费用上限：${config.maxSpendPerBatchCny} 元`);
  log.plain('─'.repeat(64));
  log.plain('');
  log.info('正在调用 GET /v1/models（免费）…');

  let models;
  try {
    models = await listModels(config, { logger: log });
  } catch (e) {
    if (e instanceof ApiError) {
      log.error(`自检失败：${e.message}`);
      if (e.status === 401) {
        log.plain('');
        log.plain('  → 密钥无效。请检查 .env 里 XINLIU_MEDIA_API_KEY 是否填对。');
      } else if (e.status === 403) {
        log.plain('');
        log.plain('  → 无权限。请确认令牌分组为 low 且已开通媒体模型。');
      }
    } else {
      log.error(`网络异常：${e.message}`);
    }
    process.exitCode = 1;
    return;
  }

  log.ok(`密钥有效，返回 ${models.length} 个模型。`);
  log.plain('');

  const hasImage = models.includes(config.imageModel);
  const hasVideo = models.includes(config.videoModel);

  log.plain(`  ${hasImage ? '✓' : '✖'} ${config.imageModel}`);
  log.plain(`  ${hasVideo ? '✓' : '✖'} ${config.videoModel}`);
  log.plain('');

  if (!hasImage || !hasVideo) {
    log.warn('目标模型不在可用列表里。');
    log.plain('');
    log.plain('  可能原因：当前令牌分组（low）未开通该模型，或模型名有变动。');
    log.plain('  请到心流后台检查分组权限。');
    log.plain('');
    const fuzzy = models.filter((m) => /grok|imagine|video|image/i.test(m));
    if (fuzzy.length) {
      log.plain('  名称相近的可用模型：');
      for (const m of fuzzy.slice(0, 20)) log.plain(`    - ${m}`);
    }
    process.exitCode = 1;
    return;
  }

  log.ok('两个模型都可用，可以进入生成流程。');
  log.plain('');
  log.plain('  下一步（都会先报价并等你输入「确认生成」）：');
  log.plain('    npm run quote   -- 只看报价，不提交，零花费');
  log.plain('');
}

main().catch((e) => {
  log.error(`未预期的错误：${e?.message ?? e}`);
  process.exitCode = 1;
});
