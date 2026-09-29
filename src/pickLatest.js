/**
 * 在 work/ 里找最新的产物。
 *
 * 第 8、9、10 步都要「拿上一步的结果」，但文件名带时间戳，
 * 而且 uniquePath() 可能加了 -2 后缀。与其让用户每次手敲文件名，
 * 不如按修改时间挑最新的，同时允许显式指定。
 *
 * 优先级：composed-* > rough-cut-*
 * 合成版（带字幕转场）永远优先于粗剪，即使粗剪更新 —— 因为
 * 重跑 edit.js 不应该让 preview 退回到没字幕的版本。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';

/** 按前缀找最新文件，返回绝对路径或 null。 */
export function latestByPrefix(dir, prefix, ext = '.mp4') {
  if (!existsSync(dir)) return null;
  const hits = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.toLowerCase().endsWith(ext))
    .map((f) => {
      const p = resolve(dir, f);
      return { path: p, mtime: statSync(p).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return hits[0]?.path ?? null;
}

/**
 * 解析输入视频。
 *
 * @param explicit  用户显式给的路径（可以是绝对路径，或相对项目根目录）
 * @param dirs      { work, outputs, root }
 * @param prefixes  按优先级排列的前缀
 */
export function resolveSource(explicit, dirs, prefixes = ['composed-', 'rough-cut-']) {
  if (explicit) {
    const p = isAbsolute(explicit) ? explicit : resolve(dirs.root, explicit);
    if (!existsSync(p)) throw new Error(`找不到指定的文件：${p}`);
    return { path: p, why: '你指定的' };
  }

  for (const prefix of prefixes) {
    const hit = latestByPrefix(dirs.work, prefix);
    if (hit) {
      return {
        path: hit,
        why: prefix === 'composed-' ? 'work/ 里最新的合成版' : 'work/ 里最新的粗剪（还没合成字幕）',
      };
    }
  }

  throw new Error(
    'work/ 里没有可用的视频。\n' +
      '    先合成：npm run compose\n' +
      '    或先拼接：npm run edit -- --mute'
  );
}
