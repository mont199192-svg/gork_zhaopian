/**
 * 人工确认闸门。
 *
 * 规则：必须一字不差输入「确认生成」才继续。
 * 输入 y / yes / 确认 / 好 等一律不算 —— 这个门槛要高到不可能手滑。
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export const CONFIRM_PHRASE = '确认生成';

export class ConfirmationDeclined extends Error {
  constructor(input) {
    super(`未获确认（输入为 "${input}"），已取消，未产生任何费用。`);
    this.name = 'ConfirmationDeclined';
  }
}

/**
 * 等待用户输入确认短语。
 * @returns {Promise<true>} 确认通过
 * @throws {ConfirmationDeclined} 未确认
 */
export async function requireConfirmation({ prompt } = {}) {
  const hint =
    prompt ??
    `\n请输入「${CONFIRM_PHRASE}」以提交上述收费任务（其他任何输入都会取消）：`;

  if (!stdin.isTTY) {
    throw new ConfirmationDeclined(
      '(非交互终端，无法确认。请在 VS Code 终端里直接运行此命令。)'
    );
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(hint + ' ');
    const trimmed = answer.trim();
    if (trimmed !== CONFIRM_PHRASE) {
      throw new ConfirmationDeclined(trimmed);
    }
    return true;
  } finally {
    rl.close();
  }
}

/**
 * 收费调用的统一入口闸门。
 * 任何会花钱的操作都必须先过这里。
 */
export async function gate({ quote, renderedQuote, config, logger }) {
  logger.plain(renderedQuote);

  if (quote.overLimit) {
    throw new Error(
      `预计费用 ${quote.totalCny.toFixed(2)} 元超过单批上限 ` +
        `${config.maxSpendPerBatchCny} 元，已中止。`
    );
  }

  if (!config.requireConfirmation) {
    // 配置允许跳过，但仍然要留下明确记录
    logger.warn('REQUIRE_CONFIRMATION=false，跳过人工确认。强烈建议改回 true。');
    return true;
  }

  await requireConfirmation();
  logger.ok('已确认，开始提交。');
  return true;
}
