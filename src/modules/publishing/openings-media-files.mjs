import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { prepareArtifactReference } from '@trebla/publishing';
import sharp from 'sharp';

const execFile = promisify(execFileCallback);
const FFPROBE_TIMEOUT_MS = 10_000;
const FFPROBE_MAX_BUFFER = 64 * 1024;
const FORMATS = Object.freeze({
  opengraph: Object.freeze({ mediaType: 'image/png', imageFormat: 'png', width: 1200, height: 630,
    extension: 'png', maxByteSize: 50_000_000 }),
  'instagram-feed': Object.freeze({ mediaType: 'image/jpeg', imageFormat: 'jpeg', width: 1080, height: 1350,
    extension: 'jpg', maxByteSize: (2 * 1024 * 1024) - 1 }),
  'social-video': Object.freeze({ mediaType: 'video/mp4', width: 1080, height: 1920,
    extension: 'mp4', maxByteSize: 50_000_000 }),
});

async function inspectImage(filePath, format) {
  let metadata;
  try { metadata = await sharp(filePath).metadata(); }
  catch { throw new Error('Prepared media format is invalid'); }
  if (metadata.format !== format.imageFormat || metadata.width !== format.width || metadata.height !== format.height) {
    throw new Error('Prepared media format or dimensions are invalid');
  }
}

async function inspectVideo(filePath, format, { ffprobePath, execFileImpl }) {
  let output;
  try {
    output = await execFileImpl(ffprobePath, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'format=format_name:stream=codec_type,width,height',
      '-of', 'json',
      filePath,
    ], { timeout: FFPROBE_TIMEOUT_MS, maxBuffer: FFPROBE_MAX_BUFFER });
  } catch {
    throw new Error('Prepared social video inspection failed');
  }
  let value;
  try { value = JSON.parse(String(output.stdout)); }
  catch { throw new Error('Prepared social video inspection failed'); }
  const stream = Array.isArray(value?.streams) && value.streams.length === 1 ? value.streams[0] : null;
  const formats = typeof value?.format?.format_name === 'string' ? value.format.format_name.split(',') : [];
  if (!formats.includes('mp4') || stream?.codec_type !== 'video'
    || stream.width !== format.width || stream.height !== format.height) {
    throw new Error('Prepared social video format or dimensions are invalid');
  }
}

export async function describeOpeningsMediaFile({
  role,
  filePath,
  logicalArtifactId,
  renderVersion,
  ffprobePath = 'ffprobe',
  execFileImpl = execFile,
}) {
  const format = FORMATS[role];
  if (!format || typeof filePath !== 'string' || filePath.length === 0
    || typeof logicalArtifactId !== 'string' || logicalArtifactId.length === 0
    || typeof renderVersion !== 'string' || !/^[1-9][0-9]{0,31}$/u.test(renderVersion)) {
    throw new Error('Prepared media declaration is invalid');
  }
  if (role === 'social-video') {
    await inspectVideo(filePath, format, { ffprobePath, execFileImpl });
  } else {
    await inspectImage(filePath, format);
  }
  const reference = await prepareArtifactReference({
    id: logicalArtifactId,
    filePath,
    storage: 'r2-temporary',
    locator: (digest) => `temporary/openings/preparation/${digest}.${format.extension}`,
    mediaType: format.mediaType,
    allowedMediaTypes: [format.mediaType],
    maxByteSize: format.maxByteSize,
  });
  return Object.freeze({
    role,
    logicalArtifactId,
    sha256: reference.sha256,
    byteSize: reference.byteSize,
    mediaType: format.mediaType,
    width: format.width,
    height: format.height,
    renderVersion,
  });
}
