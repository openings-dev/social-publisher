import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import sharp from 'sharp';
import { EDITORIAL_CATALOG } from '../../content/editorial-catalog.mjs';
import { createEditorialSlideSvg, renderEditorialAssets, resolveEditorialTheme } from './editorial-card.mjs';

const wordmarkSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><path fill="#21302E" d="M0 0h1202v219H0z"/></svg>';
const options = { wordmarkSvg };
const decorativeTitles = new Set(['Do it today', 'Try this', 'A useful adjustment', 'Why it matters', 'Quick checklist']);
const visible = svg => [...svg.matchAll(/<text\b[^>]*>(.*?)<\/text>/gu)].map(match => match[1]).join(' ').replace(/&amp;/gu, '&').replace(/&apos;|&#39;/gu, "'").replace(/&quot;/gu, '"').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>');

test('standalone editorial renderer configures its bundled Figtree fonts', () => {
  const env = { ...process.env };
  delete env.FONTCONFIG_FILE;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('./editorial-card.mjs', import.meta.url).href)}); console.log(process.env.FONTCONFIG_FILE ?? '');`], { env, encoding: 'utf8' });
  assert.match(output, /openings-figtree-.+fonts\.conf/u);
});

test('every editorial slide retains complete guidance in the clean reading guide', () => {
  assert.equal(EDITORIAL_CATALOG.length, 36);
  for (const content of EDITORIAL_CATALOG) {
    const svgs = content.slides.map((slide, index) => ({ svg: createEditorialSlideSvg(content, index, options), texts: [decorativeTitles.has(slide.title) ? null : slide.title, slide.body, slide.before, slide.after, ...(slide.items ?? [])].filter(Boolean), story: false, final: index === 6 }));
    for (const { svg, texts, story, final } of svgs) {
      assert.match(svg, /data-editorial-render-version="5"/u);
      assert.match(svg, /font-family="Figtree/u);
      assert.equal((svg.match(/<rect\b/gu) ?? []).length, 1, 'Only the canvas has a rectangle');
      assert.doesNotMatch(svg, /<circle|<filter|SWIPE TO APPLY|YOUR NEXT STEP|NEW GUIDE|FULL STEP-BY-STEP|@openingshq/u);
      const copy = visible(svg);
      for (const title of decorativeTitles) assert.ok(!copy.includes(title), `Decorative title remains: ${title}`);
      for (const text of texts) assert.ok(copy.includes(text.replace(/\s+/gu, ' ').trim()), `${content.id}: missing ${text}`);
      assert.doesNotMatch(copy, /…/u);
      assert.equal((copy.match(/→/gu) ?? []).length, final ? 1 : 0);
      if (story) assert.ok(copy.endsWith('Share this tip →'));
      else if (final) assert.match(copy, /(Save for later|Share this tip|Save for your next portfolio update) →$/u);
      assert.doesNotMatch(copy, /Salve|Compartilhe|na bio/u);
      const image = /<image\b[^>]*x="(?:124|365)" y="([\d.]+)" width="(\d+)"/u.exec(svg);
      assert.ok(image);
      assert.ok(Number(image[1]) >= (story ? 280 : 144));
      assert.ok(Number(image[2]) >= 290 && Number(image[2]) <= 350);
      for (const text of svg.matchAll(/<text\b[^>]*x="([\d.]+)" y="([\d.]+)"[^>]*font-size="([\d.]+)"/gu)) {
        assert.ok(Number(text[1]) >= 108 && Number(text[1]) <= 972);
        assert.ok(Number(text[2]) - Number(text[3]) >= (story ? 280 : 144));
        assert.ok(Number(text[2]) <= (story ? 1536 : 1206));
      }
    }
  }
});

test('editorial supports both horizontal alignments with compact vertically centered groups', () => {
  for (const alignment of ['left', 'center']) {
    for (const content of EDITORIAL_CATALOG) {
      for (const svg of content.slides.map((_, i) => createEditorialSlideSvg(content, i, { ...options, alignment }))) {
        assert.match(svg, new RegExp(`data-alignment="${alignment}"`));
        const group = /data-group-top="([\d.]+)" data-group-height="([\d.]+)"/u.exec(svg);
        assert.ok(group, 'Renderer must center a measured stack');
        const story = svg.includes('data-editorial-story');
        assert.ok(Math.abs(Number(group[1]) + Number(group[2]) / 2 - (story ? 908 : 675)) < 1);
        assert.match(svg, new RegExp(`text-anchor="${alignment === 'center' ? 'middle' : 'start'}"`));
      }
    }
  }
  assert.throws(() => createEditorialSlideSvg(EDITORIAL_CATALOG[0], 0, { ...options, alignment: 'right' }), /alignment/u);
});

test('portfolio uses the approved seven-slide English case study', () => {
  const content = EDITORIAL_CATALOG.find(item => item.id === 'resume-portfolio-que-prova');
  assert.equal(content.layout, 'short-guide');
  assert.deepEqual(content.slides.map(slide => slide.title.replace(/\s+/gu, ' ')), [
    'Turn a project into a case study.', 'Start with the problem.', 'Show your contribution.',
    'Explain one trade-off.', 'Describe what changed.', 'Check the public link.', 'Review your case study.',
  ]);
  const svg = createEditorialSlideSvg(content, 0, options);
  assert.match(svg, />Turn a project into<\/text>/u);
  assert.match(svg, /fill="#B0EC9C"[^>]*>a case study\.<\/text>/u);
  assert.match(svg, /font-size="96"/u);
  assert.match(svg, /data-alignment="left"/u);
});

test('editorial palette is stable and uses the four approved colors', () => {
  const themes = EDITORIAL_CATALOG.map(content => resolveEditorialTheme(content.id));
  assert.notEqual(themes[0].id, themes[1].id);
  assert.deepEqual(new Set(themes.map(theme => theme.background)), new Set(['#172624', '#FFFEFA', '#EEE8F8', '#FFE2D7']));
  for (const content of EDITORIAL_CATALOG) assert.deepEqual(resolveEditorialTheme(content.id), resolveEditorialTheme(content.id));
});

test('editorial rejects active and external SVG wordmarks', () => {
  for (const payload of ['<script/>', '<foreignObject/>', '<path onclick="alert(1)"/>', '<image href="file:///etc/passwd"/>', '<style>@import "https://example.com"</style>', '<path fill="url(https://example.com)"/>', '<!ENTITY x "bad">']) {
    assert.throws(() => createEditorialSlideSvg(EDITORIAL_CATALOG[0], 0, { wordmarkSvg: `<svg>${payload}</svg>` }), /wordmark/iu);
  }
});

test('all 36 carousels render at native dimensions with pixels inside reading guides', async () => {
  for (const alignment of ['left', 'center']) {
  for (const content of EDITORIAL_CATALOG) {
    const alignedOptions = { ...options, alignment };
    const assets = await renderEditorialAssets(content, alignedOptions);
    assert.equal(assets.slides.length, 7);
    for (const [index, buffer] of assets.slides.entries()) {
      const metadata = await sharp(buffer).metadata();
      assert.equal(metadata.format, 'jpeg');
      assert.equal(metadata.width, 1080);
      assert.equal(metadata.height, 1350);
      assert.ok(buffer.byteLength < 4 * 1024 * 1024);
      const svg = createEditorialSlideSvg(content, index, alignedOptions);
      const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const background = /<rect[^>]*fill="(#[A-Fa-f0-9]{6})"/u.exec(svg)[1].slice(1).match(/../gu).map(channel => Number.parseInt(channel, 16));
      const top = 144;
      const bottom = 1206;
      let outside = 0;
      let inside = 0;
      let first = info.height, last = -1;
      for (let y = 0; y < info.height; y += 1) {
        for (let x = 0; x < info.width; x += 1) {
          const offset = (y * info.width + x) * info.channels;
          const foreground = background.some((channel, channelIndex) => Math.abs(data[offset + channelIndex] - channel) > 3);
          if (!foreground) continue;
          first = Math.min(first, y); last = Math.max(last, y);
          if (x < 108 || x >= 972 || y < top || y >= bottom) outside += 1;
          else inside += 1;
        }
      }
      assert.equal(outside, 0, `${content.id} asset ${index}: native pixels exceed reading guide`);
      assert.ok(inside > 1000, 'Native artwork must contain visible content');
      assert.ok(Math.abs((first + last) / 2 - (top + bottom) / 2) < 24, `${content.id} asset ${index}: visible group is not vertically centered`);
    }
  }
  }
});
