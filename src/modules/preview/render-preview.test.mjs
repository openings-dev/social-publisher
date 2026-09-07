import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFile = promisify(execFileCallback);
const root = fileURLToPath(new URL('../../../', import.meta.url));

test('approved preview renders from a source copy without Git history or a stash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-preview-source-'));
  const checkout = join(directory, 'social-publisher');
  try {
    await mkdir(checkout);
    await cp(join(root, 'src'), join(checkout, 'src'), { recursive: true });
    await cp(join(root, 'assets/fonts'), join(checkout, 'assets/fonts'), { recursive: true });
    await cp(join(root, 'assets/fixtures'), join(checkout, 'assets/fixtures'), { recursive: true });
    await symlink(join(root, 'node_modules'), join(checkout, 'node_modules'), 'dir');
    await mkdir(join(directory, 'web/public'), { recursive: true });
    await writeFile(join(directory, 'web/public/openings-wordmark-light.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219" fill="#21302E"/></svg>');
    await assert.doesNotReject(execFile(process.execPath, ['src/modules/preview/render-preview.mjs'], {
      cwd: checkout, env: { ...process.env, PATH: '' }, timeout: 180_000,
    }));
    const manifest = JSON.parse(await readFile(join(checkout, '.tmp/social-preview/manifest.json'), 'utf8'));
    assert.deepEqual(manifest.variants, ['night', 'editorial', 'lavender', 'peach']);
    const story = await readFile(join(checkout, '.tmp/social-preview/hourly/night/story.jpg'));
    const reel = await readFile(join(checkout, '.tmp/social-preview/hourly/night/reel.jpg'));
    assert.ok(story.equals(reel), 'The preview must show the same final Story/Reel image');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
