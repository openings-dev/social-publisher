import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

test('native renderer resolves bundled Figtree instead of silently using Arial', () => {
  const code = `import sharp from 'sharp';
    await import('./src/modules/render/social-card.mjs');
    const render = family => sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="500" height="100"><text x="10" y="70" font-family="'+family+'" font-size="56">Back-end Remote</text></svg>')).png().toBuffer();
    const figtree = await render('Figtree'); const fallback = await render('Arial');
    if (figtree.equals(fallback)) process.exit(2);`;
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--input-type=module', '-e', code]), 'Figtree is falling back to Arial');
});
