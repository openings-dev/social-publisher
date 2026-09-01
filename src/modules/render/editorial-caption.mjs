import { validateEditorialContent } from '../editorial/editorial-model.mjs';

export function formatEditorialCaption(content) {
  validateEditorialContent(content);
  const actions = content.slides
    .filter(({ kind }) => kind === 'action')
    .map(({ title, body }) => `• ${title}: ${body}`)
    .join('\n');
  const sources = content.sources.map(({ title, author }) => `${title}, ${author}`).join('; ');
  const hashtags = content.hashtags.map((value) => `#${value}`).join(' ');
  const caption = [
    content.title,
    content.caption.hook,
    actions,
    content.caption.action,
    `Sources: ${sources}.`,
    hashtags,
  ].join('\n\n');
  if (caption.length > 2_200) throw new Error('Editorial caption exceeds the Instagram limit');
  return caption;
}
