/**
 * 日志。所有输出都过一遍 scrub()，保证密钥不会漏出去。
 */

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './config.js';
import { scrub } from './secret.js';

let secrets = [];

/** 注册需要过滤的密钥。在 main 入口调一次。 */
export function registerSecrets(list) {
  secrets = list.filter(Boolean);
}

function clean(msg) {
  const text =
    typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2) ?? String(msg);
  return scrub(text, secrets);
}

function writeFile(line) {
  try {
    const dir = resolve(ROOT, 'logs');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    appendFileSync(resolve(dir, `${day}.log`), line + '\n', 'utf8');
  } catch {
    // 日志写不进去不该让主流程挂掉
  }
}

function emit(level, msg) {
  const text = clean(msg);
  const stamp = new Date().toISOString();
  writeFile(`${stamp} [${level}] ${text}`);
  return text;
}

export const log = {
  info(msg) {
    console.log(emit('INFO', msg));
  },
  warn(msg) {
    console.warn('⚠  ' + emit('WARN', msg));
  },
  error(msg) {
    console.error('✖  ' + emit('ERROR', msg));
  },
  ok(msg) {
    console.log('✓  ' + emit('OK', msg));
  },
  /** 纯展示用，不写文件（表格、分隔线之类） */
  plain(msg) {
    console.log(clean(msg));
  },
};
