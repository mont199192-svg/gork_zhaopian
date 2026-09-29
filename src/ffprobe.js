/**
 * ffprobe 封装。用于校验下载到的视频是不是完整可用的文件。
 *
 * 下载成功不等于文件可用 —— 可能是半截、可能是个错误页。
 * 花了钱的素材必须验过才算数。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';

const exec = promisify(execFile);

/** 读取媒体文件信息。失败抛错。 */
export async function probe(filePath) {
  if (!existsSync(filePath)) throw new Error(`文件不存在：${filePath}`);

  const { stdout } = await exec(
    'ffprobe',
    [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ],
    { maxBuffer: 10 * 1024 * 1024 }
  );

  const info = JSON.parse(stdout);
  const video = (info.streams ?? []).find((s) => s.codec_type === 'video');
  const audio = (info.streams ?? []).find((s) => s.codec_type === 'audio');

  if (!video) {
    throw new Error(`文件里没有视频流，可能下载不完整或不是视频：${filePath}`);
  }

  // 帧率是 "30000/1001" 这种分数形式
  let fps = null;
  if (typeof video.r_frame_rate === 'string' && video.r_frame_rate.includes('/')) {
    const [a, b] = video.r_frame_rate.split('/').map(Number);
    if (b) fps = Math.round((a / b) * 1000) / 1000;
  }

  return {
    path: filePath,
    durationSec: Number(info.format?.duration) || null,
    bytes: Number(info.format?.size) || null,
    formatName: info.format?.format_name ?? null,
    width: video.width ?? null,
    height: video.height ?? null,
    fps,
    videoCodec: video.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    hasAudio: Boolean(audio),
    nbFrames: Number(video.nb_frames) || null,
  };
}

/**
 * 校验下载的视频是否符合预期。
 * 返回 { ok, problems: [], info }
 */
export async function verifyVideo(filePath, expected = {}) {
  const problems = [];
  let info;

  try {
    info = await probe(filePath);
  } catch (e) {
    return { ok: false, problems: [e.message], info: null };
  }

  if (!info.durationSec || info.durationSec < 0.5) {
    problems.push(`时长异常：${info.durationSec} 秒`);
  }

  if (expected.seconds && info.durationSec) {
    // 生成模型给的时长不会精确到帧，容忍 1.5 秒偏差
    const diff = Math.abs(info.durationSec - expected.seconds);
    if (diff > 1.5) {
      problems.push(
        `时长与预期差距较大：预期 ${expected.seconds} 秒，实际 ${info.durationSec.toFixed(2)} 秒`
      );
    }
  }

  if (expected.width && expected.height) {
    if (info.width !== expected.width || info.height !== expected.height) {
      problems.push(
        `分辨率不符：预期 ${expected.width}x${expected.height}，实际 ${info.width}x${info.height}`
      );
    }
  }

  if (info.bytes !== null && info.bytes < 10_000) {
    problems.push(`文件过小（${info.bytes} 字节），可能不完整`);
  }

  return { ok: problems.length === 0, problems, info };
}

/**
 * 读取纯音频文件信息。
 *
 * 不能用 probe() —— 它要求必须有视频流，wav/mp3 会直接抛错。
 * 配音和音效都是纯音频，需要单独一条路。
 */
export async function probeAudio(filePath) {
  if (!existsSync(filePath)) throw new Error(`文件不存在：${filePath}`);

  const { stdout } = await exec(
    'ffprobe',
    [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ],
    { maxBuffer: 10 * 1024 * 1024 }
  );

  const info = JSON.parse(stdout);
  const audio = (info.streams ?? []).find((s) => s.codec_type === 'audio');

  if (!audio) {
    throw new Error(`文件里没有音频流：${filePath}`);
  }

  // 有些格式 format.duration 缺失，退回到流上的 duration
  const durationSec =
    Number(info.format?.duration) || Number(audio.duration) || null;

  return {
    path: filePath,
    durationSec,
    bytes: Number(info.format?.size) || null,
    formatName: info.format?.format_name ?? null,
    audioCodec: audio.codec_name ?? null,
    sampleRate: Number(audio.sample_rate) || null,
    channels: Number(audio.channels) || null,
  };
}

/** 确认 ffmpeg / ffprobe 可用。 */
export async function checkFfmpeg() {
  const out = {};
  for (const bin of ['ffmpeg', 'ffprobe']) {
    try {
      const { stdout } = await exec(bin, ['-version'], { maxBuffer: 1024 * 1024 });
      out[bin] = stdout.split('\n')[0].trim();
    } catch {
      out[bin] = null;
    }
  }
  return out;
}

/** 人类可读的视频摘要。 */
export function describeVideo(info) {
  if (!info) return '(无信息)';
  const parts = [
    `${info.width}x${info.height}`,
    info.durationSec ? `${info.durationSec.toFixed(2)}s` : null,
    info.fps ? `${info.fps}fps` : null,
    info.videoCodec,
    info.hasAudio ? `音频 ${info.audioCodec}` : '无音频',
  ].filter(Boolean);
  return parts.join(' · ');
}
