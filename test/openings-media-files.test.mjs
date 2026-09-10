import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import sharp from 'sharp';

import { describeOpeningsMediaFile } from '../src/modules/publishing/openings-media-files.mjs';

const execFile = promisify(execFileCallback);

test('inspects real PNG, JPEG, and MP4 bytes before declaring owner media', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-owner-media-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pngPath = join(directory, 'opengraph-image.png');
  const jpegPath = join(directory, 'instagram-image.jpg');
  const videoPath = join(directory, 'social-video.mp4');
  await Promise.all([
    sharp({ create: { width: 1200, height: 630, channels: 3, background: '#112233' } }).png().toFile(pngPath),
    sharp({ create: { width: 1080, height: 1350, channels: 3, background: '#eeeeee' } }).jpeg().toFile(jpegPath),
    execFile('/opt/homebrew/bin/ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1080x1920:d=0.04',
      '-frames:v', '1', '-pix_fmt', 'yuv420p', videoPath,
    ], { timeout: 10_000, maxBuffer: 64 * 1024 }),
  ]);
  const [png, jpeg, video] = await Promise.all([
    describeOpeningsMediaFile({ role: 'opengraph', filePath: pngPath,
      logicalArtifactId: 'opengraph', renderVersion: '2' }),
    describeOpeningsMediaFile({ role: 'instagram-feed', filePath: jpegPath,
      logicalArtifactId: 'instagram-feed', renderVersion: '7' }),
    describeOpeningsMediaFile({ role: 'social-video', filePath: videoPath,
      logicalArtifactId: 'social-video', renderVersion: '8' }),
  ]);
  assert.deepEqual(png, { role: 'opengraph', logicalArtifactId: 'opengraph', sha256: png.sha256,
    byteSize: png.byteSize, mediaType: 'image/png', width: 1200, height: 630, renderVersion: '2' });
  assert.deepEqual(jpeg, { role: 'instagram-feed', logicalArtifactId: 'instagram-feed', sha256: jpeg.sha256,
    byteSize: jpeg.byteSize, mediaType: 'image/jpeg', width: 1080, height: 1350, renderVersion: '7' });
  assert.deepEqual(video, { role: 'social-video', logicalArtifactId: 'social-video', sha256: video.sha256,
    byteSize: video.byteSize, mediaType: 'video/mp4', width: 1080, height: 1920, renderVersion: '8' });
});

test('rejects misleading image and MP4 headers and bounds the injected ffprobe process', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-owner-invalid-media-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const imagePath = join(directory, 'wrong.png');
  const fakeVideoPath = join(directory, 'fake.mp4');
  await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000000' } }).png().toFile(imagePath);
  await writeFile(fakeVideoPath, Buffer.from('0000ftypisomnot-a-real-video'));
  await assert.rejects(describeOpeningsMediaFile({ role: 'opengraph', filePath: imagePath,
    logicalArtifactId: 'opengraph', renderVersion: '2' }), /format|dimensions/u);
  let invocation;
  await assert.rejects(describeOpeningsMediaFile({ role: 'social-video', filePath: fakeVideoPath,
    logicalArtifactId: 'social-video', renderVersion: '8', execFileImpl: async (file, args, options) => {
      invocation = { file, args, options };
      return { stdout: JSON.stringify({ format: { format_name: 'data' }, streams: [] }) };
    } }), /format|dimensions/u);
  assert.equal(invocation.file, 'ffprobe');
  assert.equal(invocation.options.timeout, 10_000);
  assert.equal(invocation.options.maxBuffer, 64 * 1024);
  assert.deepEqual(invocation.args.slice(0, 4), ['-v', 'error', '-select_streams', 'v:0']);
});
