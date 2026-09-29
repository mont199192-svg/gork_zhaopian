#!/usr/bin/env node
/**
 * 本地 TTS 配音。npm run tts [-- 项目]
 *
 * 零花费。用 Windows 自带的语音合成把 subtitles.json 里的文案念出来，
 * 每条字幕一个 wav，存到 assets/vo/。
 *
 * 音色只有系统自带的 Microsoft Huihui（中文女声），是典型的系统朗读音，
 * 撑不起电影调性。这一步的价值是先把时间轴对准 —— 确认每句话的
 * 长度和位置合适之后，换成你自己录的或付费 TTS 都能直接复用。
 *
 * 两个必须绕的坑：
 * 1. 中文经 PowerShell 命令行传参会因代码页变成乱码，所以文案走 base64。
 * 2. 生成的音频长度和字幕窗口往往不一致，脚本会逐条报出来，
 *    超时的用 atempo 压快（最多 1.3 倍，再快就不像人说话了）。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

import { log } from './logger.js';
import { resolveProject, loadShots, projectPaths } from './project.js';
import { Ledger } from './jobs.js';
import { probe, probeAudio, checkFfmpeg } from './ffprobe.js';
import { humanSize, fileSize } from './download.js';
import { loadSubtitles, computeOffsets } from './compose.js';
import { resolveCueTimes } from './ass.js';

const exec = promisify(execFile);

/** atempo 超过这个倍数就不像人说话了，宁可让字幕多留一会儿。 */
const MAX_TEMPO = 1.3;

function parseArgs(argv) {
  const args = {
    project: null,
    voice: 'Microsoft Huihui Desktop',
    rate: 0,
    transitionSec: 0.5,
    fit: true,
    listVoices: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--voice') args.voice = argv[++i];
    else if (a === '--rate') args.rate = Number(argv[++i]);
    else if (a === '--transition-sec') args.transitionSec = Number(argv[++i]);
    else if (a === '--no-fit') args.fit = false;
    else if (a === '--list-voices') args.listVoices = true;
    else if (a === '--') continue;
    else if (!a.startsWith('--')) args.project = a;
    else throw new Error(`不认识的参数 "${a}"。`);
  }
  if (!Number.isInteger(args.rate) || args.rate < -10 || args.rate > 10) {
    throw new Error(`--rate 必须是 -10 到 10 之间的整数（负数更慢），收到 ${args.rate}。`);
  }
  return args;
}

/** PowerShell 单引号字符串里，单引号本身要写两遍。 */
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

async function listVoices() {
  const script = [
    'Add-Type -AssemblyName System.Speech;',
    '(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices()',
    '| ForEach-Object { $_.VoiceInfo.Name + " | " + $_.VoiceInfo.Culture + " | " + $_.VoiceInfo.Gender }',
  ].join(' ');
  const { stdout } = await exec('powershell', ['-NoProfile', '-Command', script], {
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim().split(/\r?\n/).filter(Boolean);
}

/**
 * 念一句话到 wav。
 * 文案走 base64 是为了绕开 PowerShell 的命令行编码问题。
 */
async function speak(text, outPath, { voice, rate }) {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const script = [
    'Add-Type -AssemblyName System.Speech;',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
    `$s.SelectVoice(${psQuote(voice)});`,
    `$s.Rate = ${rate};`,
    `$s.SetOutputToWaveFile(${psQuote(outPath)});`,
    `$t = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(${psQuote(b64)}));`,
    '$s.Speak($t);',
    '$s.Dispose();',
  ].join(' ');

  try {
    await exec('powershell', ['-NoProfile', '-Command', script], { maxBuffer: 4 * 1024 * 1024 });
  } catch (e) {
    throw new Error(
      `语音合成失败：\n    ${String(e.stderr ?? e.message).split('\n').slice(-6).join('\n    ')}`
    );
  }

  if (!existsSync(outPath)) throw new Error(`语音合成没有产出文件：${outPath}`);
  return outPath;
}

/**
 * 把音频压快到目标时长。
 * atempo 只改语速不改音调，所以压快不会变成鸭子叫。
 * 超过 MAX_TEMPO 就不压了 —— 宁可让旁白盖到下一句，也不要念得像机器人。
 */
async function fitDuration(srcPath, outPath, actualSec, budgetSec) {
  const need = actualSec / budgetSec;
  if (need <= 1.02) return { path: srcPath, tempo: 1, clamped: false };

  const tempo = Math.min(need, MAX_TEMPO);
  await exec(
    'ffmpeg',
    ['-y', '-v', 'error', '-i', srcPath, '-filter:a', `atempo=${tempo.toFixed(4)}`, outPath],
    { maxBuffer: 20 * 1024 * 1024 }
  );
  return { path: outPath, tempo, clamped: need > MAX_TEMPO };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (e) {
    log.error(e.message);
    process.exitCode = 1;
    return;
  }

  if (args.listVoices) {
    const voices = await listVoices();
    log.plain('');
    log.plain('系统已安装的语音：');
    for (const v of voices) log.plain(`    ${v}`);
    log.plain('');
    log.plain('  用 --voice "名字" 指定。中文文案要选 zh-CN 的音色。');
    log.plain('');
    return;
  }

  const bins = await checkFfmpeg();
  if (!bins.ffmpeg || !bins.ffprobe) {
    log.error('找不到 ffmpeg 或 ffprobe。请确认它们在 PATH 里。');
    process.exitCode = 1;
    return;
  }

  let projectDir, data, paths, subs;
  try {
    projectDir = resolveProject(args.project);
    data = loadShots(projectDir);
    paths = projectPaths(projectDir);
    subs = loadSubtitles(paths);
  } catch (e) {
    log.error(e.message);
    process.exitCode = 1;
    return;
  }

  if (!subs || subs.cues.length === 0) {
    log.error('没有 project/subtitles.json 或里面没有字幕条目，没有文案可念。');
    process.exitCode = 1;
    return;
  }

  // 音色必须存在，否则 SelectVoice 会抛异常
  const voices = await listVoices();
  const names = voices.map((v) => v.split('|')[0].trim());
  if (!names.includes(args.voice)) {
    log.error(`系统里没有音色 "${args.voice}"。`);
    log.plain('');
    log.plain('  现有音色：');
    for (const v of voices) log.plain(`    ${v}`);
    process.exitCode = 1;
    return;
  }

  // ---- 还原时间轴，和 compose/frames 用同一套算法 ----
  const ledger = new Ledger(projectDir);
  const clips = [];
  for (const shot of data.shots) {
    const rec = ledger.get(shot.id);
    let file = rec?.outputPath;
    if (!file || !existsSync(file)) {
      const guess = resolve(paths.input, `${shot.id}.mp4`);
      file = existsSync(guess) ? guess : null;
    }
    if (!file) continue;
    const ci = await probe(file);
    clips.push({ shot, durationSec: ci.durationSec ?? 0 });
  }

  if (clips.length === 0) {
    log.error('找不到镜头素材，没法算字幕对应的时间点。');
    process.exitCode = 1;
    return;
  }

  const { offsets } = computeOffsets(clips, args.transitionSec);
  const { cues, warnings } = resolveCueTimes(subs.cues, offsets);
  for (const w of warnings) log.warn(w);

  if (cues.length === 0) {
    log.error('字幕条目都对不上镜头，没法配音。');
    process.exitCode = 1;
    return;
  }

  const voDir = resolve(paths.assets, 'vo');
  mkdirSync(voDir, { recursive: true });
  const tmpDir = resolve(paths.work, 'tts-tmp');
  mkdirSync(tmpDir, { recursive: true });

  log.plain('');
  log.plain(`项目：${data.meta.title ?? projectDir}`);
  log.plain('─'.repeat(64));
  log.plain(`音色：${args.voice}   语速：${args.rate}`);
  log.plain(`文案：${cues.length} 句`);
  log.plain('');
  log.info('合成中…');
  log.plain('');

  const results = [];
  let tight = 0;

  for (const [i, c] of cues.entries()) {
    const idx = String(i + 1).padStart(2, '0');
    const budget = c.endSec - c.startSec;
    const rawPath = resolve(tmpDir, `raw-${idx}.wav`);

    try {
      await speak(c.text, rawPath, { voice: args.voice, rate: args.rate });
    } catch (e) {
      log.error(`第 ${i + 1} 句失败：${e.message}`);
      process.exitCode = 1;
      return;
    }

    // 不吞错误：探测失败会让语速自适应静默失效，宁可当场报出来
    const rawInfo = await probeAudio(rawPath);
    const rawSec = rawInfo.durationSec ?? 0;
    if (!rawSec) throw new Error(`第 ${i + 1} 句合成出来时长为 0，音频不可用。`);

    // 文件名带镜头 id 和起始时间，compose.js 按这个铺回时间轴
    const finalName = `${c.shot}-${idx}-${c.startSec.toFixed(2)}s.wav`;
    const finalPath = resolve(voDir, finalName);

    let tempo = 1;
    let clamped = false;
    if (args.fit && rawSec > 0) {
      const fitted = await fitDuration(
        rawPath,
        resolve(tmpDir, `fit-${idx}.wav`),
        rawSec,
        budget
      );
      tempo = fitted.tempo;
      clamped = fitted.clamped;
      await exec('ffmpeg', ['-y', '-v', 'error', '-i', fitted.path, finalPath], {
        maxBuffer: 20 * 1024 * 1024,
      });
    } else {
      await exec('ffmpeg', ['-y', '-v', 'error', '-i', rawPath, finalPath], {
        maxBuffer: 20 * 1024 * 1024,
      });
    }

    const outInfo = await probeAudio(finalPath);
    const outSec = outInfo.durationSec ?? 0;
    const over = outSec - budget;

    let mark = '✓';
    if (over > 0.25) {
      mark = '!';
      tight++;
    }

    log.plain(
      `    ${mark} ${c.shot}  ${c.startSec.toFixed(2)}s  ` +
        `念 ${outSec.toFixed(2)}s / 字幕 ${budget.toFixed(2)}s` +
        (tempo > 1 ? `  压快 ${tempo.toFixed(2)}×` : '') +
        (clamped ? '（已到语速上限）' : '')
    );
    log.plain(`        「${c.text}」`);

    results.push({ name: finalName, shot: c.shot, startSec: c.startSec, outSec, budget, over });
  }

  // 临时文件不留
  rmSync(tmpDir, { recursive: true, force: true });

  const totalBytes = results.reduce((a, r) => a + (fileSize(resolve(voDir, r.name)) ?? 0), 0);

  log.plain('');
  log.plain('═'.repeat(64));
  log.ok(`配音完成：${voDir.replace(projectDir, '.')}`);
  log.plain(`  ${results.length} 段  ${humanSize(totalBytes)}`);

  if (tight > 0) {
    log.plain('');
    log.warn(`${tight} 句即使压到语速上限仍然比字幕窗口长，会盖到后面。`);
    log.plain('  两个办法：把 subtitles.json 里对应的 end 往后延，或者把文案改短。');
  }

  log.plain('');
  log.plain('  这是系统朗读音，只用来对时间轴，音色撑不起片子。');
  log.plain('  合成进片子：npm run compose');
  log.plain('  要换成自己录的：把 assets/vo/ 里的文件替换成同名的录音即可。');
  log.plain('');
}

export { parseArgs, psQuote, speak, listVoices, fitDuration, MAX_TEMPO };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    log.error(e.message);
    process.exitCode = 1;
  });
}
