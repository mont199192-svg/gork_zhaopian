#!/usr/bin/env node
/**
 * 模拟自检。npm run dryrun
 *
 * 完全离线，不发任何 HTTP 请求，不花一分钱。
 * 用假数据验证四件事：
 *   1. 价格算得对不对
 *   2. 参数校验挡不挡得住坏数据
 *   3. 台账能不能防住重复提交
 *   4. 密钥会不会漏进日志
 *
 * 台账测试用临时目录，跑完即删，不污染真实项目。
 */

import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { Secret, scrub } from '../src/secret.js';
import { Ledger, planSubmission } from '../src/jobs.js';
import { quoteImages, quoteVideos, quoteBatch, round2, fmt } from '../src/pricing.js';
import {
  validateSeconds,
  validateResolution,
  validateReferenceImages,
  validateShotList,
  ValidationError,
} from '../src/validate.js';
import { buildImagePayload, buildImageChatPayload, extractTaskId, classifyStatus, extractStatus, ENDPOINTS } from '../src/fieldMap.js';
import {
  buildVideoPayload,
  Lk888FieldError,
  classifyTask as lkClassify,
  extractVideoUrl as lkVideoUrl,
  extractTaskId as lkTaskId,
  extractCost as lkCost,
} from '../src/lk888.js';
import { classifyHttpError, looksLikeModeration, extractUpstreamStatus } from '../src/errors.js';
import { parseImageUrl, findUrls, ImageUrlParseError } from '../src/parseImageUrl.js';
import { uniquePath } from '../src/download.js';

let pass = 0;
let fail = 0;
const failures = [];

function ok(name) {
  pass++;
  console.log(`  ✓ ${name}`);
}

function bad(name, detail) {
  fail++;
  failures.push({ name, detail });
  console.log(`  ✖ ${name}`);
  if (detail) console.log(`      ${detail}`);
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(name);
  else bad(name, `期望 ${e}，实际 ${a}`);
}

function isTrue(name, cond, detail) {
  if (cond) ok(name);
  else bad(name, detail);
}

/**
 * 断言某段代码一定抛错。
 *
 * expect 可以是构造函数（断言错误类型）或正则（断言错误文案）。
 * 有些校验故意抛普通 Error，这时候只有文案能区分是不是抛对了。
 */
function throws(name, fn, expect = ValidationError) {
  try {
    fn();
    bad(name, '应该抛错但没有抛');
  } catch (e) {
    if (expect instanceof RegExp) {
      if (expect.test(e.message)) ok(name);
      else bad(name, `错误文案不匹配 ${expect}：${e.message}`);
      return;
    }
    if (e instanceof expect) ok(name);
    else bad(name, `抛了 ${e.name}，期望 ${expect.name}：${e.message}`);
  }
}

function section(title) {
  console.log('');
  console.log(title);
  console.log('─'.repeat(64));
}

// ============================================================
// 假配置：价格与 .env.example 一致
// ============================================================
const fakeConfig = {
  imageModel: 'grok-imagine-image-2.0',
  videoModel: 'gk-video-3.5',
  price: {
    imagePerCall: 0.08,
    // lk888 的单价直接是人民币/秒，不再经过 rechargeRatio
    videoPerSecondCny: { '480p': 0.1656, '720p': 0.1656 },
    rechargeRatio: 0.5,
  },
  maxSpendPerBatchCny: 10,
  requireConfirmation: true,
};

// ============================================================
section('一、价格计算');
// ============================================================

// 3 张参考图 = 3 × 0.08 × 0.5 = 0.12 元
const iq = quoteImages(3, fakeConfig);
eq('3 张参考图 = 0.12 元', round2(iq.totalCny), 0.12);
eq('单张 = 0.04 元', round2(iq.unitCny), 0.04);

// 3 × 6 秒 720p = 18 × 0.1656 = 2.9808 → 2.98 元
const threeShots = [
  { id: 'shot-01', seconds: 6, resolution: '720p' },
  { id: 'shot-02', seconds: 6, resolution: '720p' },
  { id: 'shot-03', seconds: 6, resolution: '720p' },
];
const vq = quoteVideos(threeShots, fakeConfig);
eq('3×6秒 720p = 2.98 元', round2(vq.totalCny), 2.98);
eq('总时长 18 秒', vq.totalSeconds, 18);

// 合计 = 参考图 0.12 + 视频 2.98 = 3.10 元
const batch = quoteBatch({ images: 3, shots: threeShots }, fakeConfig);
eq('参考图+视频合计 = 3.10 元', round2(batch.totalCny), 3.1);
isTrue('3.10 元未超 10 元上限', batch.overLimit === false);

// 每秒单价：两个档位同价，且不再乘 rechargeRatio
eq('720p 每秒 0.17 元', round2(quoteVideos([{ id: 'a', seconds: 1, resolution: '720p' }], fakeConfig).totalCny), 0.17);
eq('480p 每秒 0.17 元', round2(quoteVideos([{ id: 'a', seconds: 1, resolution: '480p' }], fakeConfig).totalCny), 0.17);

// 按剧本给每个镜头不同秒数：5+8+6 = 19 秒 × 0.1656 = 3.1464 → 3.15 元
const varShots = [
  { id: 'shot-01', seconds: 5, resolution: '720p' },
  { id: 'shot-02', seconds: 8, resolution: '720p' },
  { id: 'shot-03', seconds: 6, resolution: '720p' },
];
const varQ = quoteVideos(varShots, fakeConfig);
eq('不等长镜头总时长 19 秒', varQ.totalSeconds, 19);
eq('5+8+6 秒 = 3.15 元', round2(varQ.totalCny), 3.15);

// gk-video-3.5 没有 1080p 档位，报价阶段就要拦住
throws(
  '1080p 没有价格配置，报价即报错',
  () => quoteVideos([{ id: 'a', seconds: 6, resolution: '1080p' }], fakeConfig),
  /1080p/
);

// 费用上限拦截：20 × 15 × 0.1656 = 49.68 元
const overBatch = quoteBatch(
  { images: 0, shots: Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, seconds: 15, resolution: '720p' })) },
  fakeConfig
);
isTrue('20×15秒（49.68元）触发上限拦截', overBatch.overLimit === true, `实际 ${fmt(overBatch.totalCny)}`);

// ============================================================
section('二、参数校验');
// ============================================================

// gk-video-3.5 收 1~15 的任意整数秒，按秒计费。
eq('15 秒合法', validateSeconds(15).seconds, 15);
eq('字符串 "15" 合法', validateSeconds('15').seconds, 15);
eq('6 秒合法', validateSeconds(6).seconds, 6);
eq('1 秒合法（下限）', validateSeconds(1).seconds, 1);

throws('0 秒被拒', () => validateSeconds(0));
throws('负数被拒', () => validateSeconds(-3));
throws('16 秒被拒（超上限）', () => validateSeconds(16));
throws('小数 15.5 被拒', () => validateSeconds(15.5));
throws('字符串 "6.5" 被拒', () => validateSeconds('6.5'));
throws('非数字 "abc" 被拒', () => validateSeconds('abc'));

isTrue('6 秒无警告', validateSeconds(6).warnings.length === 0);
// 按秒计费，长镜头值得提醒一句，但不拦
isTrue('15 秒给出计费提醒', validateSeconds(15).warnings.length === 1);

// 报错要说清上限是多少
let secMsg = '';
try { validateSeconds(20); } catch (e) { secMsg = e.message; }
isTrue('超限报错指明 1~15', secMsg.includes('1~15'), secMsg);

eq('720p 合法', validateResolution('720p'), '720p');
eq('480p 合法', validateResolution('480p'), '480p');
eq('大写 720P 归一化', validateResolution('720P'), '720p');
throws('1080p 被拒（本模型无此档）', () => validateResolution('1080p'));
throws('4k 被拒', () => validateResolution('4k'));
throws('空分辨率被拒', () => validateResolution(''));

// 参考图：只收 1 张首帧图
eq('空参考图返回空数组', validateReferenceImages([]), []);
eq('undefined 返回空数组', validateReferenceImages(undefined), []);
eq('1 张 https 通过', validateReferenceImages(['https://a.com/1.png']).length, 1);
throws('2 张被拒（只收 1 张首帧图）', () =>
  validateReferenceImages(['https://a.com/1.png', 'https://a.com/2.png'])
);
throws('base64 被拒', () => validateReferenceImages(['data:image/png;base64,iVBOR']));
throws('本地 Windows 路径被拒', () => validateReferenceImages(['E:\\学习\\a.png']));
throws('相对路径被拒', () => validateReferenceImages(['./input/refs/a.png']));
throws('http 被拒', () => validateReferenceImages(['http://a.com/1.png']));

// 镜头 ID 重复必须被拦（否则台账防重失效）
throws('镜头 ID 重复被拒', () =>
  validateShotList([
    { id: 'dup', prompt: 'a', seconds: 6, resolution: '720p' },
    { id: 'dup', prompt: 'b', seconds: 6, resolution: '720p' },
  ])
);
throws('空提示词被拒', () => validateShotList([{ id: 'x', prompt: '   ', seconds: 6, resolution: '720p' }]));

// ============================================================
section('三、请求体字段');
// ============================================================

// lk888 的请求体是三层结构：{model, prompt, params:{...}}
const FRAME = 'https://a.com/frame.png';
const payload = buildVideoPayload({
  model: 'gk-video-3.5',
  prompt: '测试提示词',
  images: [FRAME],
  seconds: 6,
  resolution: '720p',
  aspectRatio: '16:9',
});

eq('model 在顶层', payload.model, 'gk-video-3.5');
eq('prompt 在顶层', payload.prompt, '测试提示词');
eq('duration 是字符串 "6"', payload.params.duration, '6');
eq('aspect_ratio 在 params 里', payload.params.aspect_ratio, '16:9');
eq('resolution 在 params 里', payload.params.resolution, '720p');
eq('images 是 1 元素数组', payload.params.images.length, 1);
isTrue('没有顶层 seconds/size 字段', !('seconds' in payload) && !('size' in payload));
isTrue('没有 reference_images 字段', !('reference_images' in payload.params));

// notify_url 是顶层字段，放进 params 会被忽略
const withHook = buildVideoPayload({
  model: 'm', prompt: 'p', images: [FRAME], seconds: 6,
  resolution: '720p', aspectRatio: '16:9', notifyUrl: 'https://cb.example/hook',
});
eq('notify_url 在顶层', withHook.notify_url, 'https://cb.example/hook');
isTrue('notify_url 不在 params 里', !('notify_url' in withHook.params));
isTrue('不传时不带 notify_url 字段', !('notify_url' in payload));

// 图生视频模型：没图必定被拒，本地先挡掉，别浪费一次请求
throws(
  '无首帧图被拒',
  () => buildVideoPayload({ model: 'm', prompt: 'p', seconds: 6, resolution: '720p', aspectRatio: '16:9' }),
  Lk888FieldError
);
throws(
  '2 张图被拒',
  () => buildVideoPayload({ model: 'm', prompt: 'p', images: [FRAME, FRAME], seconds: 6, resolution: '720p', aspectRatio: '16:9' }),
  Lk888FieldError
);
throws(
  '1080p 被拒（本模型无此档）',
  () => buildVideoPayload({ model: 'm', prompt: 'p', images: [FRAME], seconds: 6, resolution: '1080p', aspectRatio: '16:9' }),
  Lk888FieldError
);
throws(
  '非法 aspect_ratio 被拒',
  () => buildVideoPayload({ model: 'm', prompt: 'p', images: [FRAME], seconds: 6, resolution: '720p', aspectRatio: '4:3' }),
  Lk888FieldError
);
throws(
  '16 秒被拒',
  () => buildVideoPayload({ model: 'm', prompt: 'p', images: [FRAME], seconds: 16, resolution: '720p', aspectRatio: '16:9' }),
  Lk888FieldError
);
throws(
  '空 prompt 被拒',
  () => buildVideoPayload({ model: 'm', prompt: '   ', images: [FRAME], seconds: 6, resolution: '720p', aspectRatio: '16:9' }),
  Lk888FieldError
);

// 9:16 竖屏在这个平台是合法的（心流不支持，这家支持）
eq(
  '9:16 竖屏合法',
  buildVideoPayload({ model: 'm', prompt: 'p', images: [FRAME], seconds: 6, resolution: '720p', aspectRatio: '9:16' }).params.aspect_ratio,
  '9:16'
);

// ---- 终态判定：只认 state + is_final，不认中文展示字段 ----
eq('state=success → success', lkClassify({ state: 'success', is_final: true }), 'success');
eq('state=failed → failure', lkClassify({ state: 'failed', is_final: true }), 'failure');
eq('state=running → pending', lkClassify({ state: 'running', is_final: false }), 'pending');
eq('state=pending → pending', lkClassify({ state: 'pending', is_final: false }), 'pending');
eq('data 包一层也能读', lkClassify({ data: { state: 'success', is_final: true } }), 'success');
// status / status_group 是中文展示字段，文档明确说别拿来写逻辑
eq('只有中文 status 时算 unknown', lkClassify({ status: '已完成' }), 'unknown');
// state 读不懂但 is_final=true：按失败处理，别无限轮下去
eq('state 未知但 is_final=true → failure', lkClassify({ state: 'weird', is_final: true }), 'failure');
eq('state 未知但 is_final=false → pending', lkClassify({ state: 'weird', is_final: false }), 'pending');
eq('什么都没有 → unknown', lkClassify({}), 'unknown');

eq('result_url 提取', lkVideoUrl({ result_url: 'https://a.com/v.mp4' }), 'https://a.com/v.mp4');
eq('没有 result_url 返回 null', lkVideoUrl({ state: 'success' }), null);
eq('lk888 task_id 转字符串', lkTaskId({ task_id: 12345 }), '12345');
eq('cost 用于对账', lkCost({ cost: 0.9936 }), 0.9936);

// 图片请求体（OpenAI 图片格式，非聊天格式）
const imgPayload = buildImagePayload({ model: 'grok-imagine-image-2.0', prompt: '画一张图' });
eq('图片 model', imgPayload.model, 'grok-imagine-image-2.0');
eq('图片 prompt 直接放顶层', imgPayload.prompt, '画一张图');
eq('图片 n 默认 1', imgPayload.n, 1);
// size 必须显式带上，不带的话画幅由模型猜，实测会猜错（frame-01 猜成 1024x1024）
eq('图片 size 默认 1280x720', imgPayload.size, '1280x720');
eq(
  '图片 size 可覆盖',
  buildImagePayload({ model: 'm', prompt: 'p', size: '1920x1080' }).size,
  '1920x1080'
);

// 聊天格式仅作备用，心流若改回聊天端点时启用
const chatPayload = buildImageChatPayload({ model: 'grok-imagine-image-2.0', prompt: '画一张图' });
eq('备用聊天格式 messages 结构', chatPayload.messages, [{ role: 'user', content: '画一张图' }]);
eq('备用聊天格式 stream = false', chatPayload.stream, false);

// task_id 提取：两种字段名都要认
eq('从 task_id 取', extractTaskId({ task_id: 'abc123' }), 'abc123');
eq('从 id 取', extractTaskId({ id: 'xyz789' }), 'xyz789');
eq('task_id 优先于 id', extractTaskId({ task_id: 'first', id: 'second' }), 'first');
eq('都没有返回 null', extractTaskId({ foo: 'bar' }), null);
eq('空字符串返回 null', extractTaskId({ task_id: '  ' }), null);

// 状态归类
eq('succeeded → success', classifyStatus('succeeded'), 'success');
eq('completed → success', classifyStatus('completed'), 'success');
eq('failed → failure', classifyStatus('failed'), 'failure');
eq('processing → pending', classifyStatus('processing'), 'pending');
eq('queued → pending', classifyStatus('queued'), 'pending');
eq('大写 SUCCEEDED 也认', classifyStatus(extractStatus({ status: 'SUCCEEDED' })), 'success');
eq('没见过的状态 → unknown', classifyStatus('weird_state'), 'unknown');

// ============================================================
section('四、错误分类（决定能否重试）');
// ============================================================

eq('400 → fatal', classifyHttpError(400, {}).category, 'fatal');
eq('401 → fatal', classifyHttpError(401, {}).category, 'fatal');
eq('402 → fatal', classifyHttpError(402, {}).category, 'fatal');
eq('403 → fatal', classifyHttpError(403, {}).category, 'fatal');
eq('404 → fatal', classifyHttpError(404, {}).category, 'fatal');
eq('429 → rate_limit', classifyHttpError(429, {}).category, 'rate_limit');
eq('500 → transient', classifyHttpError(500, {}).category, 'transient');
eq('502 → transient', classifyHttpError(502, {}).category, 'transient');
eq('503 → transient', classifyHttpError(503, {}).category, 'transient');
eq('504 → transient', classifyHttpError(504, {}).category, 'transient');

// 审核拒绝必须独立分类，且优先于状态码
eq(
  'moderation_blocked → moderation',
  classifyHttpError(400, { error: { code: 'moderation_blocked' } }).category,
  'moderation'
);
eq(
  'content_policy → moderation',
  classifyHttpError(400, { error: 'content_policy violation' }).category,
  'moderation'
);
eq('中文「审核」→ moderation', classifyHttpError(400, { message: '内容审核未通过' }).category, 'moderation');
isTrue('审核关键词识别', looksLikeModeration({ error: 'Rejected by safety filter' }));
isTrue('普通 400 不误判为审核', !looksLikeModeration({ error: 'invalid seconds parameter' }));

// 心流会把上游 4xx 包装成自己的 5xx。真实的 xAI 422 长这样：
const wrapped422 = {
  error: { message: 'status_code=422, {"message":"xAI 服务返回状态码 422","type":"upstream_error"}' },
};
eq('包装的上游 422 挖出真实码', extractUpstreamStatus(wrapped422), 422);
eq('中文「返回状态码 NNN」也能挖出', extractUpstreamStatus({ message: 'xAI 服务返回状态码 422' }), 422);
eq('正文无上游码时返回 null', extractUpstreamStatus({ code: 'upstream_error', message: '暂时不可用' }), null);

// 关键：外层 502 但上游 422，必须判成 fatal 而不是 transient——
// 否则会提示用户「稍后重试」，而上游 4xx 重试多少次都一样。
eq('502 包 422 → fatal', classifyHttpError(502, wrapped422).category, 'fatal');
isTrue('提示里点明是上游 422', classifyHttpError(502, wrapped422).hint.includes('422'));
isTrue(
  '提示里给出排查方向',
  classifyHttpError(502, wrapped422).hint.includes('参考图'),
  classifyHttpError(502, wrapped422).hint
);
// 上游 429 例外：那确实值得等一会儿再来，不该归成 fatal
eq(
  '502 包 429 仍按外层 transient',
  classifyHttpError(502, { message: 'status_code=429, rate limited' }).category,
  'transient'
);
// 纯粹的心流自身 5xx（正文没有上游码）仍然是 transient
eq(
  '502 无上游码 → transient',
  classifyHttpError(502, { code: 'upstream_error', message: '暂时不可用' }).category,
  'transient'
);

// ============================================================
section('五、台账防重复扣费');
// ============================================================

const tmp = mkdtempSync(resolve(tmpdir(), 'vwf-test-'));
try {
  mkdirSync(resolve(tmp, 'state'), { recursive: true });
  const ledger = new Ledger(tmp);

  const shot = { id: 'shot-01', prompt: 'p', seconds: 6, resolution: '720p', referenceImages: [] };

  // 全新镜头可以提交
  eq('全新镜头允许提交', ledger.canSubmit('shot-01').allowed, true);

  // 提交前落痕 submitting
  ledger.markSubmitting('shot-01', { model: 'v', seconds: 6, resolution: '720p', prompt: 'p', estimatedCny: 0.99 });
  const afterSubmitting = ledger.canSubmit('shot-01');
  isTrue('submitting 且无 task_id 时禁止再提交', afterSubmitting.allowed === false);
  eq('原因是结果未知', afterSubmitting.reason, 'unknown_outcome');
  isTrue(
    '提示用户先查心流使用日志',
    afterSubmitting.message.includes('使用日志'),
    afterSubmitting.message
  );

  // 拿到 task_id
  ledger.markTaskId('shot-01', 'task-abc-123');
  const afterTaskId = ledger.canSubmit('shot-01');
  isTrue('有 task_id 时禁止重新提交', afterTaskId.allowed === false);
  eq('原因是任务进行中', afterTaskId.reason, 'in_flight');
  isTrue('提示会重复扣费', afterTaskId.message.includes('重复扣费'));

  // --force 也不能绕过进行中的任务（这条最关键）
  const forceInFlight = ledger.canSubmit('shot-01', { force: true });
  isTrue('--force 也无法绕过进行中的任务', forceInFlight.allowed === false, JSON.stringify(forceInFlight));

  // 成功后跳过
  ledger.markSuccess('shot-01', { outputPath: 'input/shot-01.mp4', actualCny: 0.99 });
  isTrue('成功后默认跳过', ledger.canSubmit('shot-01').allowed === false);
  eq('原因是已成功', ledger.canSubmit('shot-01').reason, 'already_success');
  isTrue('--force 可以重做已成功的镜头', ledger.canSubmit('shot-01', { force: true }).allowed === true);
  eq('累计花费记录 0.99', round2(ledger.totalSpent()), 0.99);

  // 失败后默认不重提
  ledger.markSubmitting('shot-02', { model: 'v', seconds: 6, resolution: '720p', prompt: 'p', estimatedCny: 0.99 });
  ledger.markTaskId('shot-02', 'task-def-456');
  ledger.markFailed('shot-02', '内容审核拒绝');
  const failedCheck = ledger.canSubmit('shot-02');
  isTrue('失败后默认不允许重提', failedCheck.allowed === false);
  eq('原因是已失败', failedCheck.reason, 'already_failed');
  isTrue('失败提示包含原因', failedCheck.message.includes('内容审核拒绝'));
  isTrue('--force 可以重试失败的镜头', ledger.canSubmit('shot-02', { force: true }).allowed === true);
  eq('失败也计入花费（保守）', round2(ledger.totalSpent()), 1.98);

  // planSubmission 的整体过滤
  const shots = [
    { id: 'shot-01', prompt: 'a', seconds: 6, resolution: '720p', referenceImages: [] }, // success
    { id: 'shot-02', prompt: 'b', seconds: 6, resolution: '720p', referenceImages: [] }, // failed
    { id: 'shot-03', prompt: 'c', seconds: 6, resolution: '720p', referenceImages: [] }, // new
  ];
  const plan = planSubmission(shots, ledger, { force: false });
  eq('只有 shot-03 待提交', plan.toSubmit.map((t) => t.shot.id), ['shot-03']);
  eq('shot-01 和 shot-02 被跳过', plan.skipped.map((s) => s.shot.id), ['shot-01', 'shot-02']);

  // 关键场景：重跑命令不应重复扣费
  const rerunQuote = quoteBatch({ images: 0, shots: plan.toSubmit.map((t) => t.shot) }, fakeConfig);
  eq('重跑只报 1 个镜头的价（0.99 元）', round2(rerunQuote.totalCny), 0.99);

  // 归档而非删除
  ledger.markSubmitting('shot-02', { model: 'v', seconds: 6, resolution: '720p', prompt: 'p2', estimatedCny: 0.99 });
  isTrue('force 重提时旧记录进 history 而非丢失', ledger.data.history.length >= 1);
  eq('attempts 递增', ledger.get('shot-02').attempts, 2);

  // 台账真的落盘了
  const onDisk = JSON.parse(readFileSync(resolve(tmp, 'state', 'jobs.json'), 'utf8'));
  isTrue('台账已写入磁盘', onDisk.jobs['shot-01'].status === 'success');

  // 不能简单搜 'sk-' —— task_id 里的 "task-xxx" 会误报。
  // 真正要防的是：台账里出现形如 sk-<长串> 的密钥，或出现 Authorization 头。
  const onDiskText = JSON.stringify(onDisk);
  isTrue(
    '磁盘台账不含密钥串',
    !/\b(sk|hf|ghp|xai)-[A-Za-z0-9_-]{12,}/.test(onDiskText),
    onDiskText.match(/\b(sk|hf|ghp|xai)-[A-Za-z0-9_-]{12,}/)?.[0]
  );
  isTrue('磁盘台账不含 Authorization 字样', !/authorization/i.test(onDiskText));
  isTrue('磁盘台账不含 apiKey 字段', !/apikey/i.test(onDiskText));

  // 损坏的台账必须报错，不能静默重建
  writeFileSync(resolve(tmp, 'state', 'jobs.json'), '{ 这不是 JSON', 'utf8');
  try {
    new Ledger(tmp);
    bad('损坏台账应抛错', '却成功加载了');
  } catch (e) {
    isTrue('损坏台账抛错而非静默重建', e.message.includes('损坏'), e.message);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
  isTrue('临时测试目录已清理', !existsSync(tmp));
}

// ============================================================
section('六、图片 URL 解析（三种格式）');
// ============================================================

// /v1/images/generations 的真实返回结构（2026-09-28 实测）
const imagesApi = parseImageUrl({
  created: 1790604813,
  data: [{ url: 'https://iliu-ai-1446793020.cos.ap-guangzhou.myqcloud.com/media/41a44b.png' }],
  usage: { cost_in_usd_ticks: 400000000 },
});
eq('images API 结构化解析', imagesApi.url, 'https://iliu-ai-1446793020.cos.ap-guangzhou.myqcloud.com/media/41a44b.png');
eq('识别为 images_api', imagesApi.format, 'images_api');

// n>1 时返回多个
eq(
  'images API 多图全部返回',
  parseImageUrl({ data: [{ url: 'https://a.com/1.png' }, { url: 'https://a.com/2.png' }] }).all.length,
  2
);

// 图片请求体必须是 { model, prompt, n, size }，不能是聊天格式
const realImgPayload = buildImagePayload({ model: 'grok-imagine-image-2.0', prompt: '一只猫' });
eq('图片请求体字段', Object.keys(realImgPayload).sort(), ['model', 'n', 'prompt', 'size']);
eq('n 默认 1', realImgPayload.n, 1);
isTrue('图片请求体不含 messages', !('messages' in realImgPayload));
isTrue('图片请求体不含 stream', !('stream' in realImgPayload));
eq('图片端点是 /v1/images/generations', ENDPOINTS.imageCreate, '/v1/images/generations');

// 聊天格式的兜底解析仍要保留 —— 心流若改回聊天端点时用得上
const chat = (content) => ({ choices: [{ message: { role: 'assistant', content } }] });

// 格式 1：纯 URL
const p1 = parseImageUrl(chat('https://cdn.example.com/abc123.png'));
eq('纯 URL 解析', p1.url, 'https://cdn.example.com/abc123.png');
eq('识别为 bare_url', p1.format, 'bare_url');

// 格式 2：Markdown 图片
const p2 = parseImageUrl(chat('![generated image](https://cdn.example.com/abc123.png)'));
eq('Markdown 图片解析', p2.url, 'https://cdn.example.com/abc123.png');
eq('识别为 markdown_image', p2.format, 'markdown_image');
isTrue('Markdown 右括号未被吞进 URL', !p2.url.includes(')'));

// 格式 3：夹在中文文字里
const p3 = parseImageUrl(chat('好的，这是您要的参考图：https://cdn.example.com/abc123.png 希望满意。'));
eq('中文文字中解析', p3.url, 'https://cdn.example.com/abc123.png');
isTrue('中文标点未被吞进 URL', !/[。，：]/.test(p3.url));

// 其余容错格式
eq(
  'Markdown 链接',
  parseImageUrl(chat('[点击查看](https://cdn.example.com/x.jpg)')).url,
  'https://cdn.example.com/x.jpg'
);
eq(
  'HTML img 标签',
  parseImageUrl(chat('<img src="https://cdn.example.com/x.webp" alt="x">')).url,
  'https://cdn.example.com/x.webp'
);
eq(
  'JSON 片段',
  parseImageUrl(chat('{"url": "https://cdn.example.com/x.png"}')).url,
  'https://cdn.example.com/x.png'
);
eq(
  '带查询参数的签名 URL',
  parseImageUrl(chat('https://cdn.example.com/x.png?sig=abc&exp=123')).url,
  'https://cdn.example.com/x.png?sig=abc&exp=123'
);
eq(
  '多个 URL 时优先带图片扩展名的',
  parseImageUrl(chat('参考 https://docs.example.com/help 图片 https://cdn.example.com/x.png')).url,
  'https://cdn.example.com/x.png'
);
eq('尾随句号被剥离', parseImageUrl(chat('图片地址 https://cdn.example.com/x.png.')).url, 'https://cdn.example.com/x.png');

// 多模态数组格式的 content
eq(
  'content 为数组时也能取',
  parseImageUrl({
    choices: [{ message: { content: [{ type: 'image_url', image_url: { url: 'https://cdn.example.com/x.png' } }] } }],
  }).url,
  'https://cdn.example.com/x.png'
);

// 解析失败必须抛错并带上原文（钱已经花了，不能静默丢结果）
throws('无 URL 时抛错', () => parseImageUrl(chat('抱歉，我无法生成图片。')), ImageUrlParseError);
throws('无 content 时抛错', () => parseImageUrl({ choices: [] }), ImageUrlParseError);
try {
  parseImageUrl(chat('抱歉，无法生成。'));
} catch (e) {
  isTrue('报错里带原始 content 供人工取用', e.rawContent === '抱歉，无法生成。');
  isTrue('报错提示已扣费', e.message.includes('扣费'));
}

// findUrls 的边界
eq('http 不被当成候选', findUrls('http://insecure.com/x.png'), []);
eq('无 URL 返回空数组', findUrls('纯文字没有链接'), []);

// ============================================================
section('七、不覆盖已有文件');
// ============================================================

const tmp2 = mkdtempSync(resolve(tmpdir(), 'vwf-dl-'));
try {
  const f = resolve(tmp2, 'ref-character.png');
  eq('文件不存在时用原名', uniquePath(f), f);

  writeFileSync(f, 'fake');
  const second = uniquePath(f);
  isTrue('文件已存在时改名而非覆盖', second !== f, second);
  isTrue('改名为 -2 后缀', second.endsWith('ref-character-2.png'), second);

  writeFileSync(second, 'fake2');
  isTrue('第三次改名为 -3', uniquePath(f).endsWith('ref-character-3.png'));

  // 原文件内容没被动过
  eq('原文件内容未被覆盖', readFileSync(f, 'utf8'), 'fake');
} finally {
  rmSync(tmp2, { recursive: true, force: true });
}

// ============================================================
section('八、密钥防泄露');
// ============================================================

const fakeKey = new Secret('sk-testkey1234567890abcdefghij', 'TEST_KEY');

isTrue('toString 不含原文', !fakeKey.toString().includes('testkey1234567890'));
isTrue('模板字符串不含原文', !`${fakeKey}`.includes('testkey1234567890'));
isTrue('JSON.stringify 不含原文', !JSON.stringify({ k: fakeKey }).includes('testkey1234567890'));
isTrue('JSON.stringify 整个 config 不含原文', !JSON.stringify({ apiKey: fakeKey, other: 1 }).includes('testkey1234567890'));
isTrue('mask 保留前 3 位便于辨认', fakeKey.mask().startsWith('sk-'));
isTrue('reveal 能取到原文（仅限请求头）', fakeKey.reveal() === 'sk-testkey1234567890abcdefghij');
isTrue('Object.keys 不暴露原文', !Object.keys(fakeKey).some((k) => fakeKey[k] === 'sk-testkey1234567890abcdefghij'));

// scrub 兜底
const leaky = `请求失败：Authorization: Bearer sk-testkey1234567890abcdefghij 无效`;
const scrubbed = scrub(leaky, [fakeKey]);
isTrue('scrub 清掉了原文', !scrubbed.includes('testkey1234567890'), scrubbed);
isTrue('scrub 后仍可读', scrubbed.includes('请求失败'));

// 就算没注册也要被前缀规则兜住
const unregistered = scrub('key is sk-someotherkey9876543210xyz here', []);
isTrue('未注册的 sk- 串也被兜底清理', !unregistered.includes('someotherkey9876543210'), unregistered);
isTrue('Bearer 后的长串被清理', !scrub('Bearer abcdefghij1234567890', []).includes('abcdefghij1234567890'));

// ============================================================
// 汇总
// ============================================================
console.log('');
console.log('═'.repeat(64));
if (fail === 0) {
  console.log(`  全部通过：${pass} 项`);
  console.log('');
  console.log('  已验证：价格算得准、坏参数进不来、重复提交拦得住、密钥漏不出去。');
  console.log('  本次运行未发出任何 HTTP 请求，未产生费用。');
} else {
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  console.log('');
  for (const f of failures) {
    console.log(`  ✖ ${f.name}`);
    if (f.detail) console.log(`      ${f.detail}`);
  }
  process.exitCode = 1;
}
console.log('═'.repeat(64));
console.log('');
