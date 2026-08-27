import {
  SOCIAL_VIDEO_DURATION_SECONDS,
  SOCIAL_VIDEO_FPS,
  SOCIAL_VIDEO_HEIGHT,
  SOCIAL_VIDEO_WIDTH,
} from '../../config/constants.mjs';
import { SOCIAL_CARD_COLORS } from './social-card.mjs';
import { SOCIAL_CARD_FONT_STACK } from './cjk-fonts.mjs';

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BITS_PER_SAMPLE = 16;
const CARD_X = 60;
const CARD_Y = 210;
const CARD_WIDTH = 960;
const CARD_HEIGHT = 1200;
const REVEAL_HEIGHTS = Object.freeze([158, 729, 969, 1200]);
const STAGE_DURATIONS = Object.freeze(['1.65', '3.40', '2.55', '2.15']);
const TRANSITION_DURATION = '0.25';
const TRANSITION_OFFSETS = Object.freeze(['1.40', '4.55', '6.85']);
const execFile = promisify(execFileCallback);

function assertInstagramSvg(value) {
  if (typeof value !== 'string'
    || !/<svg\b[^>]*width="1080"[^>]*height="1350"[^>]*data-instagram-card="true"/iu.test(value)) {
    throw new Error('A canonical 1080×1350 Instagram SVG is required');
  }
  if (/<(?:script|foreignObject)\b|\bon[a-z]+\s*=|@import|url\(\s*["']?https?:/iu.test(value)) {
    throw new Error('Instagram SVG contains unsupported content');
  }
  return value;
}

function stageSvg(cardData, stage, revealHeight) {
  const colors = SOCIAL_CARD_COLORS;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SOCIAL_VIDEO_WIDTH}" height="${SOCIAL_VIDEO_HEIGHT}" viewBox="0 0 ${SOCIAL_VIDEO_WIDTH} ${SOCIAL_VIDEO_HEIGHT}" data-reel-stage="${stage}">
  <defs>
    <filter id="reel-shadow" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="30" stdDeviation="34" flood-color="${colors.ink}" flood-opacity="0.14"/></filter>
    <clipPath id="reveal-${stage}"><rect x="${CARD_X}" y="${CARD_Y}" width="${CARD_WIDTH}" height="${revealHeight}" rx="28" data-reel-reveal="true"/></clipPath>
  </defs>
  <rect width="1080" height="1920" fill="${colors.canvas}"/>
  <circle cx="1018" cy="180" r="230" fill="${colors.mint}"/>
  <circle cx="70" cy="1740" r="210" fill="${colors.surfaceMuted}"/>
  <text x="60" y="148" fill="${colors.mintDeep}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="23" font-weight="800" letter-spacing="2.4">New opening</text>
  <text x="1020" y="148" text-anchor="end" fill="${colors.ink}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="24" font-weight="800">@openingshq</text>
  <rect x="${CARD_X}" y="${CARD_Y}" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" rx="28" fill="${colors.paper}" stroke="${colors.line}" filter="url(#reel-shadow)"/>
  <image x="${CARD_X}" y="${CARD_Y}" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" opacity="0.075" preserveAspectRatio="none" href="data:image/svg+xml;base64,${cardData}"/>
  <g clip-path="url(#reveal-${stage})">
    <image x="${CARD_X}" y="${CARD_Y}" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" preserveAspectRatio="none" href="data:image/svg+xml;base64,${cardData}"/>
  </g>
  <text x="60" y="1512" fill="${colors.ink}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="42" font-weight="800" letter-spacing="-1.1">Your next role might be here.</text>
  <rect x="60" y="1560" width="182" height="7" rx="3.5" fill="${colors.mint}"/>
  <text x="60" y="1616" fill="${colors.mutedInk}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="25" font-weight="600">Jobs shared by public tech communities.</text>
</svg>`;
}

export function createReelStageSvgs(instagramSvg) {
  const cardData = Buffer.from(assertInstagramSvg(instagramSvg), 'utf8').toString('base64');
  return Object.freeze(REVEAL_HEIGHTS.map((height, index) => stageSvg(cardData, index + 1, height)));
}

function writeAscii(buffer, value, offset) {
  buffer.write(value, offset, value.length, 'ascii');
}

function midiFrequency(note) {
  return 440 * (2 ** ((note - 69) / 12));
}

function smoothstep(value) {
  const bounded = Math.max(0, Math.min(1, value));
  return bounded * bounded * (3 - 2 * bounded);
}

function envelope(time, duration) {
  const attack = smoothstep(time / 0.75);
  const release = smoothstep((duration - time) / 1.1);
  return Math.min(attack, release);
}

export function createOriginalSoundtrackWav({
  durationSeconds = SOCIAL_VIDEO_DURATION_SECONDS,
  sampleRate = SAMPLE_RATE,
} = {}) {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 3 || durationSeconds > 60) {
    throw new Error('Soundtrack duration must be between 3 and 60 seconds');
  }
  if (sampleRate !== SAMPLE_RATE) {
    throw new Error('Soundtrack sample rate must be 48 kHz');
  }
  const frameCount = Math.round(durationSeconds * sampleRate);
  const bytesPerSample = BITS_PER_SAMPLE / 8;
  const dataBytes = frameCount * CHANNELS * bytesPerSample;
  const wav = Buffer.alloc(44 + dataBytes);
  writeAscii(wav, 'RIFF', 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  writeAscii(wav, 'WAVE', 8);
  writeAscii(wav, 'fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(CHANNELS, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * CHANNELS * bytesPerSample, 28);
  wav.writeUInt16LE(CHANNELS * bytesPerSample, 32);
  wav.writeUInt16LE(BITS_PER_SAMPLE, 34);
  writeAscii(wav, 'data', 36);
  wav.writeUInt32LE(dataBytes, 40);

  const progressions = [
    [48, 55, 59, 64],
    [45, 52, 57, 60],
    [41, 48, 53, 57],
    [43, 50, 55, 59],
  ];
  const sectionLength = durationSeconds / progressions.length;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const time = frame / sampleRate;
    const notes = progressions[Math.min(progressions.length - 1, Math.floor(time / sectionLength))];
    let chord = 0;
    for (let index = 0; index < notes.length; index += 1) {
      const frequency = midiFrequency(notes[index]);
      chord += Math.sin(2 * Math.PI * frequency * time + index * 0.17) / (index + 2.2);
    }
    const beatPosition = (time * 1.6) % 1;
    const pulseEnvelope = Math.exp(-beatPosition * 7.5);
    const pulse = Math.sin(2 * Math.PI * 92 * time) * pulseEnvelope * 0.055;
    const amplitude = (chord * 0.105 + pulse) * envelope(time, durationSeconds);
    const left = Math.max(-1, Math.min(1, amplitude));
    const right = Math.max(-1, Math.min(1, amplitude * 0.965
      + Math.sin(2 * Math.PI * midiFrequency(notes.at(-1)) * time + 0.42) * 0.009));
    const offset = 44 + frame * CHANNELS * bytesPerSample;
    wav.writeInt16LE(Math.round(left * 32767), offset);
    wav.writeInt16LE(Math.round(right * 32767), offset + bytesPerSample);
  }
  return wav;
}

export function buildReelFfmpegArguments({ stagePaths, audioPath, outputPath }) {
  if (!Array.isArray(stagePaths) || stagePaths.length !== 4 || stagePaths.some((path) => typeof path !== 'string' || path === '')) {
    throw new Error('Exactly four Reel stage paths are required');
  }
  if (typeof audioPath !== 'string' || audioPath === '' || typeof outputPath !== 'string' || outputPath === '') {
    throw new Error('Reel audio and output paths are required');
  }
  const argumentsList = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (let index = 0; index < stagePaths.length; index += 1) {
    argumentsList.push('-loop', '1', '-t', STAGE_DURATIONS[index], '-i', stagePaths[index]);
  }
  argumentsList.push('-i', audioPath);
  const inputs = stagePaths.map((_, index) => `[${index}:v]scale=${SOCIAL_VIDEO_WIDTH}:${SOCIAL_VIDEO_HEIGHT}:flags=lanczos,setsar=1,format=rgba[v${index}]`);
  const transitions = [
    `[v0][v1]xfade=transition=fade:duration=${TRANSITION_DURATION}:offset=${TRANSITION_OFFSETS[0]}[x1]`,
    `[x1][v2]xfade=transition=fade:duration=${TRANSITION_DURATION}:offset=${TRANSITION_OFFSETS[1]}[x2]`,
    `[x2][v3]xfade=transition=fade:duration=${TRANSITION_DURATION}:offset=${TRANSITION_OFFSETS[2]},fps=${SOCIAL_VIDEO_FPS},format=yuv420p[v]`,
  ];
  argumentsList.push(
    '-filter_complex', [...inputs, ...transitions].join(';'),
    '-map', '[v]',
    '-map', '4:a:0',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-profile:v', 'high',
    '-level', '4.1',
    '-pix_fmt', 'yuv420p',
    '-r', String(SOCIAL_VIDEO_FPS),
    '-c:a', 'aac',
    '-ar', String(SAMPLE_RATE),
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-t', String(SOCIAL_VIDEO_DURATION_SECONDS),
    outputPath,
  );
  return argumentsList;
}

function assertMp4Header(value) {
  if (value.byteLength < 12 || value.subarray(4, 8).toString('ascii') !== 'ftyp') {
    throw new Error('Rendered social video is not an MP4 container');
  }
}

export async function renderReelVideo({
  instagramSvg,
  outputDirectory,
  ffmpegPath = 'ffmpeg',
  execFileImpl = execFile,
}) {
  if (typeof outputDirectory !== 'string' || outputDirectory.trim() === '') {
    throw new Error('Reel output directory is required');
  }
  const directory = resolve(outputDirectory);
  await mkdir(directory, { recursive: true });
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'openings-reel-render-'));
  const videoPath = join(directory, 'social-video.mp4');
  const coverPath = join(directory, 'social-video-cover.jpg');
  try {
    const stages = createReelStageSvgs(instagramSvg);
    const stagePaths = await Promise.all(stages.map(async (stage, index) => {
      const stagePath = join(temporaryDirectory, `stage-${index + 1}.png`);
      await sharp(Buffer.from(stage, 'utf8'))
        .png({ compressionLevel: 9, palette: true, colors: 192, quality: 92 })
        .toFile(stagePath);
      return stagePath;
    }));
    await sharp(Buffer.from(stages.at(-1), 'utf8'))
      .flatten({ background: SOCIAL_CARD_COLORS.canvas })
      .jpeg({ quality: 88, chromaSubsampling: '4:4:4' })
      .toFile(coverPath);
    const coverMetadata = await sharp(coverPath).metadata();
    if (coverMetadata.format !== 'jpeg'
      || coverMetadata.width !== SOCIAL_VIDEO_WIDTH
      || coverMetadata.height !== SOCIAL_VIDEO_HEIGHT) {
      throw new Error('Rendered social video cover has invalid dimensions');
    }

    const audioPath = join(temporaryDirectory, 'soundtrack.wav');
    await writeFile(audioPath, createOriginalSoundtrackWav());
    await execFileImpl(ffmpegPath, buildReelFfmpegArguments({
      stagePaths,
      audioPath,
      outputPath: videoPath,
    }), { maxBuffer: 4 * 1024 * 1024 });
    assertMp4Header(await readFile(videoPath));
    return Object.freeze({ videoPath, coverPath });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import sharp from 'sharp';
