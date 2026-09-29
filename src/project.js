/**
 * 项目定位与 shots.json 读取。
 *
 * 约定：所有产物都写在项目文件夹内，绝不写到项目外面去。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { ROOT } from './config.js';
import { validateShotList } from './validate.js';

export const PROJECTS_DIR = resolve(ROOT, 'projects');

/** 列出所有项目文件夹名。 */
export function listProjects() {
  if (!existsSync(PROJECTS_DIR)) return [];
  return readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/**
 * 解析项目目录。
 * 支持传文件夹名（001-xxx）、前缀（001）或绝对路径。
 */
export function resolveProject(nameOrPath) {
  if (!nameOrPath) {
    const all = listProjects();
    if (all.length === 0) throw new Error('projects/ 下没有任何项目。');
    if (all.length === 1) return resolve(PROJECTS_DIR, all[0]);
    throw new Error(
      `有多个项目，请指定：\n${all.map((n) => `    - ${n}`).join('\n')}`
    );
  }

  if (isAbsolute(nameOrPath)) {
    if (!existsSync(nameOrPath)) throw new Error(`项目目录不存在：${nameOrPath}`);
    return nameOrPath;
  }

  const direct = resolve(PROJECTS_DIR, nameOrPath);
  if (existsSync(direct)) return direct;

  const matches = listProjects().filter((n) => n.startsWith(nameOrPath));
  if (matches.length === 1) return resolve(PROJECTS_DIR, matches[0]);
  if (matches.length > 1) {
    throw new Error(
      `"${nameOrPath}" 匹配到多个项目：\n${matches.map((n) => `    - ${n}`).join('\n')}`
    );
  }
  throw new Error(`找不到项目 "${nameOrPath}"。现有项目：${listProjects().join(', ') || '无'}`);
}

/** 项目内各子目录。 */
export function projectPaths(projectDir) {
  return {
    root: projectDir,
    input: resolve(projectDir, 'input'),
    refs: resolve(projectDir, 'input', 'refs'),
    assets: resolve(projectDir, 'assets'),
    preview: resolve(projectDir, 'preview'),
    frames: resolve(projectDir, 'preview', 'frames'),
    outputs: resolve(projectDir, 'outputs'),
    project: resolve(projectDir, 'project'),
    work: resolve(projectDir, 'work'),
    state: resolve(projectDir, 'state'),
    shotsFile: resolve(projectDir, 'project', 'shots.json'),
  };
}

/** 读取并校验 shots.json。 */
export function loadShots(projectDir) {
  const p = projectPaths(projectDir);
  if (!existsSync(p.shotsFile)) {
    throw new Error(`找不到分镜文件：${p.shotsFile}`);
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(p.shotsFile, 'utf8'));
  } catch (e) {
    throw new Error(`分镜文件不是合法 JSON：${p.shotsFile}\n    ${e.message}`);
  }

  const defaults = {
    seconds: raw?.defaults?.seconds ?? 6,
    resolution: raw?.defaults?.resolution ?? '720p',
  };

  const orientation = raw?.orientation === 'landscape' ? 'landscape' : 'portrait';
  const withOrientation = (raw.shots ?? []).map((s) => ({
    orientation,
    ...s,
  }));

  const { shots, warnings } = validateShotList(withOrientation, defaults);

  const refs = Array.isArray(raw.referenceImages) ? raw.referenceImages : [];

  return {
    meta: {
      project: raw.project ?? null,
      title: raw.title ?? null,
      orientation,
      aspect: raw.aspect ?? null,
      note: raw.note ?? null,
    },
    defaults,
    referenceImages: refs,
    shots,
    warnings,
    raw,
  };
}
