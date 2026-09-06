import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import sharp from 'sharp';

import {
  SOCIAL_VIDEO_DURATION_SECONDS,
  SOCIAL_VIDEO_FPS,
  SOCIAL_VIDEO_HEIGHT,
  SOCIAL_VIDEO_WIDTH,
} from '../../config/constants.mjs';
import { escapeHtml } from '../../shared/escape.mjs';
import { sha256 } from '../../shared/hash.mjs';
import { createJobPosterSvg } from './job-poster.mjs';
import { decodeArtworkModel } from './job-poster-model.mjs';
import { resolveReelSoundtrack } from './soundtrack.mjs';
export { resolveReelSoundtrack } from './soundtrack.mjs';
import { SOCIAL_CARD_COLORS } from './social-card.mjs';
import { SOCIAL_CARD_FONT_STACK } from './cjk-fonts.mjs';
import {
  decodeSocialPosterModel,
  REEL_POSTER_GEOMETRY,
  SOCIAL_POSTER_MODEL_VERSION,
} from './social-poster-model.mjs';

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BITS_PER_SAMPLE = 16;
const STAGE_DURATIONS = Object.freeze(['1.65', '3.40', '2.55', '2.15']);
const TRANSITION_DURATION = '0.25';
const TRANSITION_OFFSETS = Object.freeze(['1.40', '4.55', '6.85']);
const execFile = promisify(execFileCallback);

function assertInstagramSvg(value) {
  if (typeof value !== 'string'
    || !/<svg\b[^>]*width="1080"[^>]*height="1350"[^>]*data-instagram-card="true"/iu.test(value)
    || !/data-social-poster-version="[34]"/u.test(value)) {
    throw new Error('A canonical 1080×1350 Instagram SVG is required');
  }
  if (/<(?:script|foreignObject)\b|\bon[a-z]+\s*=|@import|url\(\s*["']?https?:/iu.test(value)) {
    throw new Error('Instagram SVG contains unsupported content');
  }
  return value;
}

function extractPosterInput(instagramSvg) {
  const document = assertInstagramSvg(instagramSvg);
  const modelValue = /<svg\b[^>]*\bdata-poster-model="(?<model>[A-Za-z0-9+/]+={0,2})"/iu
    .exec(document)?.groups?.model;
  const wordmark = /<image\b(?=[^>]*\bdata-instagram-wordmark="true")[^>]*\bhref="(?<href>data:image\/svg\+xml;base64,[A-Za-z0-9+/]+={0,2})"[^>]*>/iu
    .exec(document)?.groups?.href;
  if (!modelValue || !wordmark) {
    throw new Error('Instagram SVG is missing its canonical poster payload');
  }
  return Object.freeze({ model: document.includes('data-social-poster-version="4"')
    ? decodeArtworkModel(modelValue) : decodeSocialPosterModel(modelValue), wordmark });
}

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

function glyphWidth(character, fontSize) {
  if (/\s/u.test(character)) return fontSize * 0.31;
  if (/[A-Z0-9]/u.test(character)) return fontSize * 0.62;
  if (/[a-z]/u.test(character)) return fontSize * 0.53;
  if (/[,.;:!?\u2013\u2014'"()[\]{}\-/]/u.test(character)) return fontSize * 0.35;
  return fontSize * 0.93;
}

function wrapFact(value, { fontSize, maxWidth, maxLines }) {
  const input = [...segmenter.segment(String(value))].map(({ segment }) => segment);
  const lines = [];
  let current = [];
  let width = 0;
  let lastBreak = -1;
  let index = 0;
  while (index < input.length && lines.length < maxLines) {
    const character = input[index];
    const characterWidth = glyphWidth(character, fontSize);
    if (current.length > 0 && width + characterWidth > maxWidth) {
      if (lastBreak >= 0) {
        const completed = current.slice(0, lastBreak).join('').trimEnd();
        const spill = current.slice(lastBreak + 1);
        if (completed) lines.push(completed);
        current = spill;
        width = spill.reduce((sum, part) => sum + glyphWidth(part, fontSize), 0);
      } else {
        lines.push(current.join('').trimEnd());
        current = [];
        width = 0;
      }
      lastBreak = -1;
      continue;
    }
    current.push(character);
    width += characterWidth;
    if (/\s/u.test(character)) lastBreak = current.length - 1;
    index += 1;
  }
  if (current.length > 0 && lines.length < maxLines) lines.push(current.join('').trimEnd());
  if (index < input.length && lines.length > 0) {
    lines[lines.length - 1] = `${lines.at(-1).replace(/[\s,.;:!?-]+$/u, '')}…`;
  }
  return lines;
}

function textLines(lines, { x, y, fontSize, lineHeight, fill, weight, attribute = '' }) {
  return lines.map((line, index) => `<text x="${x}" y="${y + index * lineHeight}" fill="${fill}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="${fontSize}" font-weight="${weight}" ${attribute}>${escapeHtml(line)}</text>`).join('');
}

function stageSvg({ model, wordmark }, stage) {
  const colors = SOCIAL_CARD_COLORS;
  const geometry = REEL_POSTER_GEOMETRY;
  const layout = model.layouts.reel;
  const titleBlockHeight = layout.titleLines.length * layout.titleLineHeight;
  const titleY = 550 + Math.max(0, (430 - titleBlockHeight) / 2)
    + Math.round(layout.titleFontSize * 0.78);
  const dominantLength = [...segmenter.segment(model.dominantFact.value)].length;
  const dominantFontSize = dominantLength > 18 ? 38 : dominantLength > 13 ? 52 : dominantLength > 11 ? 64 : 96;
  const dominantLines = wrapFact(model.dominantFact.value, {
    fontSize: dominantFontSize,
    maxWidth: 660,
    maxLines: 2,
  });
  const supporting = model.supportingFacts.map((fact, index) => {
    const x = index === 0 ? 210 : 550;
    const lines = wrapFact(fact.value, { fontSize: 28, maxWidth: 320, maxLines: 2 });
    return `<text x="${x}" y="1362" fill="${colors.mutedInk}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="15" font-weight="850" letter-spacing="1.5">${escapeHtml(fact.label)}</text>
    ${textLines(lines, { x, y: 1405, fontSize: 28, lineHeight: 34, fill: colors.ink, weight: 780 })}`;
  }).join('');
  const eyebrowLines = wrapFact(model.eyebrow.toUpperCase(), {
    fontSize: 18,
    maxWidth: 660,
    maxLines: 1,
  });
  const attributionLines = wrapFact(model.attribution.value, {
    fontSize: 28,
    maxWidth: 270,
    maxLines: 2,
  });
  const titleOpacity = stage >= 2 ? 1 : 0;
  const factsOpacity = stage >= 3 ? 1 : 0;
  const attributionOpacity = stage >= 4 ? 1 : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SOCIAL_VIDEO_WIDTH}" height="${SOCIAL_VIDEO_HEIGHT}" viewBox="0 0 ${SOCIAL_VIDEO_WIDTH} ${SOCIAL_VIDEO_HEIGHT}" data-reel-stage="${stage}" data-social-poster-version="${SOCIAL_POSTER_MODEL_VERSION}" data-theme="${model.theme.id}">
  <rect width="1080" height="1920" fill="${colors.paper}"/>
  <rect data-editorial-band="true" x="0" y="1490" width="1080" height="430" fill="${model.theme.accent}" opacity="${attributionOpacity}"/>
  <rect data-safe-area="true" x="${geometry.safeArea.x}" y="${geometry.safeArea.y}" width="${geometry.safeArea.width}" height="${geometry.safeArea.height}" fill="none"/>
  <rect data-poster-role-region="true" x="${geometry.role.x}" y="${geometry.role.y}" width="${geometry.role.width}" height="${geometry.role.height}" fill="none"/>
  <rect data-reel-facts-surface="true" data-poster-facts-region="true" x="${geometry.facts.x}" y="${geometry.facts.y}" width="${geometry.facts.width}" height="${geometry.facts.height}" rx="32" fill="${colors.surfaceMuted}" opacity="${factsOpacity}"/>
  <rect data-poster-attribution-region="true" x="${geometry.attribution.x}" y="${geometry.attribution.y}" width="${geometry.attribution.width}" height="${geometry.attribution.height}" fill="none"/>
  <g data-reel-brand="true" opacity="1" data-important-content="true" data-x="${geometry.header.x}" data-y="${geometry.header.y}" data-width="${geometry.header.width}" data-height="${geometry.header.height}">
    <image x="210" y="338" width="220" height="40" preserveAspectRatio="xMinYMid meet" href="${wordmark}"/>
    <text x="870" y="350" text-anchor="end" fill="${colors.ink}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="21" font-weight="850">${escapeHtml(model.handle)}</text>
    <text x="870" y="385" text-anchor="end" fill="${colors.mutedInk}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="16" font-weight="750">Tech jobs from public communities</text>
  </g>
  <g data-reel-title="true" opacity="${titleOpacity}" data-important-content="true" data-x="${geometry.role.x}" data-y="${geometry.role.y}" data-width="${geometry.role.width}" data-height="${geometry.role.height}">
    ${textLines(eyebrowLines, { x: 210, y: 490, fontSize: 18, lineHeight: 24, fill: colors.mutedInk, weight: 850, attribute: 'letter-spacing="1.7"' })}
    ${textLines(layout.titleLines, { x: 210, y: Math.round(titleY), fontSize: layout.titleFontSize, lineHeight: layout.titleLineHeight, fill: colors.ink, weight: 900, attribute: 'letter-spacing="-2.8" data-reel-title-line="true"' })}
  </g>
  <g data-reel-facts="true" opacity="${factsOpacity}" data-important-content="true" data-x="${geometry.facts.x}" data-y="${geometry.facts.y}" data-width="${geometry.facts.width}" data-height="${geometry.facts.height}">
    <text x="210" y="1090" fill="${colors.mutedInk}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="17" font-weight="850" letter-spacing="1.6">${escapeHtml(model.dominantFact.label)}</text>
    ${textLines(dominantLines, { x: 210, y: 1190, fontSize: dominantFontSize, lineHeight: Math.round(dominantFontSize * 1.02), fill: colors.ink, weight: 900, attribute: 'letter-spacing="-1.8" data-reel-dominant-fact="true"' })}
    ${supporting}
  </g>
  <g data-reel-attribution="true" opacity="${attributionOpacity}" data-important-content="true" data-x="${geometry.attribution.x}" data-y="${geometry.attribution.y}" data-width="${geometry.attribution.width}" data-height="${geometry.attribution.height}">
    <text x="210" y="1550" fill="${colors.ink}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="14" font-weight="850" letter-spacing="1.6">${escapeHtml(model.attribution.label)}</text>
    ${textLines(attributionLines, { x: 210, y: 1600, fontSize: 28, lineHeight: 34, fill: colors.ink, weight: 850 })}
    <rect x="510" y="1540" width="360" height="104" rx="52" fill="${colors.ink}"/>
    <text x="535" y="1602" fill="${colors.paper}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="16" font-weight="800">${escapeHtml(model.attribution.action)}</text>
    <text x="845" y="1608" text-anchor="end" fill="${model.theme.accent}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="30" font-weight="850">→</text>
  </g>
</svg>`;
}

export function createReelStageSvgs(instagramSvg) {
  const poster = extractPosterInput(instagramSvg);
  if (poster.model.version === 4) {
    const wordmarkSvg = Buffer.from(poster.wordmark.split(',')[1], 'base64').toString('utf8');
    const svg = createJobPosterSvg(poster.model, { format: 'story', wordmarkSvg });
    return Object.freeze([svg, svg, svg, svg]);
  }
  return Object.freeze([1, 2, 3, 4].map((stage) => stageSvg(poster, stage)));
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
    const coverSource = stages.at(-1);
    await sharp(Buffer.from(coverSource, 'utf8'))
      .flatten({ background: SOCIAL_CARD_COLORS.paper })
      .jpeg({ quality: 88, chromaSubsampling: '4:4:4' })
      .toFile(coverPath);
    const coverMetadata = await sharp(coverPath).metadata();
    if (coverMetadata.format !== 'jpeg'
      || coverMetadata.width !== SOCIAL_VIDEO_WIDTH
      || coverMetadata.height !== SOCIAL_VIDEO_HEIGHT) {
      throw new Error('Rendered social video cover has invalid dimensions');
    }

    const soundtrack = await resolveReelSoundtrack(instagramSvg);
    const audioPath = soundtrack?.path ?? join(temporaryDirectory, 'soundtrack.wav');
    if (!soundtrack) await writeFile(audioPath, createOriginalSoundtrackWav());
    await execFileImpl(ffmpegPath, buildReelFfmpegArguments({
      stagePaths,
      audioPath,
      outputPath: videoPath,
    }), { maxBuffer: 4 * 1024 * 1024 });
    assertMp4Header(await readFile(videoPath));
    return Object.freeze({ videoPath, coverPath, coverSourceHash: sha256(Buffer.from(coverSource, 'utf8')),
      soundtrackId: soundtrack?.id ?? 'legacy-synth', soundtrackSha256: soundtrack?.sha256 ?? null });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
