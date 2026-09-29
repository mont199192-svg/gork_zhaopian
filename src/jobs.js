/**
 * 任务台账。防重复扣费的核心。
 *
 * 每个项目一份 projects/<项目>/state/jobs.json。
 *
 * 状态机：
 *   submitting → 已发出创建请求，但还没确认结果（网络中断会停在这里）
 *   pending    → 已拿到 task_id，正在生成
 *   success    → 已完成并下载
 *   failed     → 生成失败（不自动重提）
 *
 * 铁律：
 *   1. 提交前先落一条 submitting，拿到响应再改状态。这样即使断网，
 *      台账里也留着痕迹，不会因为"不知道扣没扣钱"而盲目重提。
 *   2. 已有 task_id 的记录只能查询，禁止重新提交。
 *   3. failed 记录默认跳过，除非显式 --force。
 *   4. --force 会把旧记录归档到 history，不是删掉 —— 花过的钱要留痕。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const SCHEMA_VERSION = 1;

export class Ledger {
  constructor(projectDir) {
    this.projectDir = projectDir;
    this.path = resolve(projectDir, 'state', 'jobs.json');
    this.data = this.#load();
  }

  #load() {
    if (!existsSync(this.path)) {
      return {
        schemaVersion: SCHEMA_VERSION,
        project: this.projectDir,
        createdAt: new Date().toISOString(),
        totalSpentCny: 0,
        jobs: {},
        history: [],
      };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
      parsed.jobs ??= {};
      parsed.history ??= [];
      parsed.totalSpentCny ??= 0;
      return parsed;
    } catch (e) {
      // 台账损坏绝不能静默重建 —— 那等于丢掉所有防重记录
      throw new Error(
        `台账文件损坏，无法解析：${this.path}\n` +
          `原因：${e.message}\n` +
          `请手动检查或备份后删除该文件。自动重建会丢失防重复扣费记录，因此不会自动进行。`
      );
    }
  }

  /** 原子写入：先写临时文件再改名，避免写一半断电导致台账全毁。 */
  save() {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.data.updatedAt = new Date().toISOString();
    const tmp = this.path + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }

  get(id) {
    return this.data.jobs[id] ?? null;
  }

  all() {
    return Object.values(this.data.jobs);
  }

  /**
   * 判断某镜头能不能提交。
   * 返回 { allowed, reason, record }
   */
  canSubmit(id, { force = false } = {}) {
    const rec = this.get(id);
    if (!rec) return { allowed: true, reason: 'new', record: null };

    if (rec.taskId && (rec.status === 'pending' || rec.status === 'submitting')) {
      return {
        allowed: false,
        reason: 'in_flight',
        record: rec,
        message:
          `${id} 已有进行中的任务（task_id=${rec.taskId}，状态 ${rec.status}）。` +
          `只能继续查询，禁止重新提交 —— 重提会重复扣费。`,
      };
    }

    if (rec.status === 'submitting' && !rec.taskId) {
      return {
        allowed: false,
        reason: 'unknown_outcome',
        record: rec,
        message:
          `${id} 上次提交后结果未知（没拿到 task_id，可能是网络中断）。\n` +
          `    钱可能已经扣了。请先到心流后台「使用日志」确认这笔任务是否存在，` +
          `再决定是否用 --force 重新提交。`,
      };
    }

    if (rec.status === 'success') {
      if (!force) {
        return {
          allowed: false,
          reason: 'already_success',
          record: rec,
          message: `${id} 已生成成功（${rec.outputPath ?? '无输出路径'}），跳过。要重做请加 --force。`,
        };
      }
      return { allowed: true, reason: 'force_redo_success', record: rec };
    }

    if (rec.status === 'failed') {
      if (!force) {
        return {
          allowed: false,
          reason: 'already_failed',
          record: rec,
          message:
            `${id} 上次生成失败：${rec.error ?? '未记录原因'}\n` +
            `    按规则不自动重提。请先修改提示词或参数，再用 --force 重新提交。`,
        };
      }
      return { allowed: true, reason: 'force_retry_failed', record: rec };
    }

    return { allowed: true, reason: 'unknown_state', record: rec };
  }

  /** 步骤 1：提交前落痕。必须在发 HTTP 请求之前调用并 save()。 */
  markSubmitting(id, meta) {
    const prev = this.get(id);
    if (prev) {
      this.data.history.push({ ...prev, archivedAt: new Date().toISOString() });
    }
    this.data.jobs[id] = {
      id,
      status: 'submitting',
      taskId: null,
      model: meta.model ?? null,
      seconds: meta.seconds ?? null,
      resolution: meta.resolution ?? null,
      referenceImages: meta.referenceImages ?? [],
      promptPreview: (meta.prompt ?? '').slice(0, 80),
      estimatedCny: meta.estimatedCny ?? null,
      submittedAt: new Date().toISOString(),
      taskIdAt: null,
      finishedAt: null,
      outputPath: null,
      error: null,
      attempts: (prev?.attempts ?? 0) + 1,
    };
    this.save();
    return this.data.jobs[id];
  }

  /** 步骤 2：拿到 task_id 立刻记下来。这是最关键的一次写入。 */
  markTaskId(id, taskId) {
    const rec = this.get(id);
    if (!rec) throw new Error(`台账里没有 ${id}，不能记录 task_id`);
    rec.taskId = taskId;
    rec.status = 'pending';
    rec.taskIdAt = new Date().toISOString();
    this.save();
    return rec;
  }

  markSuccess(id, { outputPath, actualCny } = {}) {
    const rec = this.get(id);
    if (!rec) throw new Error(`台账里没有 ${id}`);
    rec.status = 'success';
    rec.outputPath = outputPath ?? null;
    rec.finishedAt = new Date().toISOString();
    const spent = actualCny ?? rec.estimatedCny ?? 0;
    rec.actualCny = spent;
    this.data.totalSpentCny = Number(
      ((this.data.totalSpentCny ?? 0) + spent).toFixed(4)
    );
    this.save();
    return rec;
  }

  /**
   * 标记失败。
   *
   * charged 三态：
   *   false —— 确定没扣费（请求被拒绝，任务从未创建）
   *   true  —— 确定扣了费
   *   null  —— 不确定（5xx / 网络中断 / 任务创建后才失败），保守按扣费记
   *
   * 记账要诚实：把没花的钱记成花了，累计花费就没有参考价值了。
   */
  markFailed(id, error, { charged = null } = {}) {
    const rec = this.get(id);
    if (!rec) throw new Error(`台账里没有 ${id}`);
    rec.status = 'failed';
    rec.error = typeof error === 'string' ? error : JSON.stringify(error);
    rec.finishedAt = new Date().toISOString();
    rec.chargeCertainty = charged === null ? 'unknown' : charged ? 'charged' : 'not_charged';

    if (charged === false) {
      rec.actualCny = 0;
    } else {
      // true 或 null 都计入（null 是保守估计）
      const spent = rec.estimatedCny ?? 0;
      rec.actualCny = spent;
      this.data.totalSpentCny = Number(
        ((this.data.totalSpentCny ?? 0) + spent).toFixed(4)
      );
    }
    this.save();
    return rec;
  }

  /** 修正某条记录的扣费金额（用于对账后更正）。 */
  /**
   * 更正扣费金额。
   *
   * 同一个 jobId 重提会把旧记录归档进 history，所以对账时经常要改的是
   * 归档记录而不是当前记录 —— 比如「成功那次实际扣了多少」在下一次重提后
   * 就已经进 history 了。带 archivedIndex 时改 history 里的第 N 条。
   */
  correctCharge(id, actualCny, { archivedIndex = null } = {}) {
    const rec =
      archivedIndex === null
        ? this.get(id)
        : (this.data.history ?? []).filter((h) => h.id === id)[archivedIndex];
    if (!rec) {
      throw new Error(
        archivedIndex === null
          ? `台账里没有 ${id}`
          : `${id} 的归档记录里没有第 ${archivedIndex} 条`
      );
    }
    const old = rec.actualCny ?? 0;
    rec.actualCny = actualCny;
    rec.chargeCorrectedAt = new Date().toISOString();
    this.data.totalSpentCny = Number(
      ((this.data.totalSpentCny ?? 0) - old + actualCny).toFixed(4)
    );
    this.save();
    return rec;
  }

  /** 累计花费。 */
  totalSpent() {
    return this.data.totalSpentCny ?? 0;
  }

  /** 摘要，给终端显示。 */
  summary() {
    const byStatus = {};
    for (const j of this.all()) {
      byStatus[j.status] = (byStatus[j.status] ?? 0) + 1;
    }
    return {
      total: this.all().length,
      byStatus,
      totalSpentCny: this.totalSpent(),
      historyCount: this.data.history.length,
    };
  }
}

/**
 * 过滤出真正需要提交的镜头，并给出跳过原因。
 */
export function planSubmission(shots, ledger, { force = false } = {}) {
  const toSubmit = [];
  const skipped = [];
  const blocked = [];

  for (const shot of shots) {
    const check = ledger.canSubmit(shot.id, { force });
    if (check.allowed) {
      toSubmit.push({ shot, reason: check.reason });
    } else if (check.reason === 'in_flight' || check.reason === 'unknown_outcome') {
      blocked.push({ shot, ...check });
    } else {
      skipped.push({ shot, ...check });
    }
  }

  return { toSubmit, skipped, blocked };
}
