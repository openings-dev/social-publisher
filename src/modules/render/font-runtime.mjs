import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { escapeHtml } from '../../shared/escape.mjs';

// Configure Fontconfig before the first SVG rasterization. Web-font CSS is ignored
// by librsvg. Keep the fonts out of dispatch payloads and out of the user's system.
const source = readFileSync(new URL('../../../assets/fonts/figtree.json', import.meta.url));
const revision = createHash('sha256').update(source).digest('hex').slice(0, 16);
const directory = join(tmpdir(), `openings-figtree-${revision}-${process.pid}`);
mkdirSync(directory, { recursive: true });
for (const [name, value] of Object.entries(JSON.parse(source))) {
  const path = join(directory, name);
  if (!existsSync(path)) writeFileSync(path, Buffer.from(value, 'base64'));
}
const inherited = process.env.FONTCONFIG_FILE;
const defaults = [inherited && resolve(inherited), '/etc/fonts/fonts.conf', '/opt/homebrew/etc/fonts/fonts.conf'].filter(Boolean);
const config = join(directory, 'fonts.conf');
const included = [...new Set(defaults)].filter(path => path !== config && existsSync(path));
writeFileSync(config, `<?xml version="1.0"?><fontconfig>${included.map(path => `<include ignore_missing="yes">${escapeHtml(path)}</include>`).join('')}<dir>${escapeHtml(directory)}</dir><cachedir>${escapeHtml(directory)}</cachedir></fontconfig>`);
process.env.FONTCONFIG_FILE = config;

export const FIGTREE_FONT_DIRECTORY = directory;
export const FIGTREE_FONT_CONFIG = config;
