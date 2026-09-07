import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { decodeArtworkModel } from './job-poster-model.mjs';

const TRACKS = Object.freeze({
  'funked-up': Object.freeze({ id: 'funked-up', title: 'Funked Up', artist: 'Joth',
    license: 'CC0-1.0', durationSeconds: 9,
    source: 'https://opengameart.org/content/funked-up',
    sha256: 'e2fa908a762add9ae8784832c14707525d7c7375cdd8c28217d0857967a79828' }),
  'funky-house': Object.freeze({ id: 'funky-house', title: 'Funky House', artist: 'Of Far Different Nature',
    license: 'CC0-1.0', durationSeconds: 9,
    source: 'https://opengameart.org/content/funky-house',
    sha256: '1422a4630babedd49544dfa7d56399918841c86154d6f19ee61bbbc9f6693435' }),
});

// The saved artwork cycle is Night/editorial/Night/editorial; deriving A/B from
// that choice preserves the music across retries without another mutable counter.
export async function resolveReelSoundtrack(instagramSvg) {
  const root = typeof instagramSvg === 'string' ? /<svg\b[^>]*>/u.exec(instagramSvg)?.[0] : null;
  const version = /\bdata-social-poster-version="([34])"/u.exec(root ?? '')?.[1];
  if (version === '3') return null; // Historical payloads retain their original audio.
  if (version !== '4') throw new Error('A supported poster is required for soundtrack selection');
  const encoded = /\bdata-poster-model="([A-Za-z0-9+/]+={0,2})"/u.exec(root)?.[1];
  const model = decodeArtworkModel(encoded);
  const track = TRACKS[model.direction === 'night' ? 'funked-up' : 'funky-house'];
  const path = fileURLToPath(new URL(`../../../assets/audio/${track.id}.mp3`, import.meta.url));
  const bytes = await readFile(path);
  if (createHash('sha256').update(bytes).digest('hex') !== track.sha256) {
    throw new Error(`Bundled soundtrack integrity check failed: ${track.id}`);
  }
  return Object.freeze({ ...track, path });
}
