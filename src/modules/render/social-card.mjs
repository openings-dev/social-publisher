import './font-runtime.mjs';
import sharp from 'sharp';
import { IMAGE_WIDTH, IMAGE_HEIGHT, INSTAGRAM_IMAGE_WIDTH, INSTAGRAM_IMAGE_HEIGHT } from '../../config/constants.mjs';
import { createArtworkSvg } from './job-poster.mjs';

const COLORS = Object.freeze({ canvas: '#f5f3ef', paper: '#fffefa', ink: '#21302e', mutedInk: '#5e6663', line: '#d8d8d1', surfaceMuted: '#f0f1ed', mint: '#b0ec9c', mintDeep: '#315d35' });

export function createSocialCardSvg(job, options) {
  return createArtworkSvg(job, { ...options, format: 'link' });
}

export function createInstagramCardSvg(job, options) {
  return createArtworkSvg(job, { ...options, format: 'feed' });
}

export async function renderSocialCardPng(job, options) {
  const svg = createSocialCardSvg(job, options);
  const png = await sharp(Buffer.from(svg)).png({
    compressionLevel: 9,
    palette: true,
    colors: 128,
    quality: 90,
  }).toBuffer();
  const metadata = await sharp(png).metadata();
  if (metadata.format !== 'png' || metadata.width !== IMAGE_WIDTH || metadata.height !== IMAGE_HEIGHT) {
    throw new Error('Rendered social card has invalid PNG dimensions');
  }
  if (png.byteLength >= 2 * 1024 * 1024) {
    throw new Error('Rendered social card exceeds 2 MB');
  }
  return png;
}

export async function renderInstagramCardJpeg(job, options) {
  const svg = createInstagramCardSvg(job, options);
  const jpeg = await sharp(Buffer.from(svg))
    .flatten({ background: COLORS.paper })
    .jpeg({ quality: 82, chromaSubsampling: '4:4:4' })
    .toBuffer();
  const metadata = await sharp(jpeg).metadata();
  if (metadata.format !== 'jpeg'
    || metadata.width !== INSTAGRAM_IMAGE_WIDTH
    || metadata.height !== INSTAGRAM_IMAGE_HEIGHT) {
    throw new Error('Rendered Instagram card has invalid JPEG dimensions');
  }
  if (jpeg.byteLength >= 2 * 1024 * 1024) {
    throw new Error('Rendered Instagram card exceeds 2 MB');
  }
  return jpeg;
}

export { COLORS as SOCIAL_CARD_COLORS };
