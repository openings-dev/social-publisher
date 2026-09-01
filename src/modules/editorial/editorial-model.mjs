const PILLARS = new Set(['linkedin', 'resume', 'search', 'application', 'interview']);
const SLIDE_KINDS = ['cover', 'context', 'action', 'example', 'action', 'checklist', 'cta'];

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}
function text(value, label, maximum = 500) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) {
    throw new Error(`${label} must be non-empty text with at most ${maximum} characters`);
  }
  if (/[<>]/u.test(value)) throw new Error(`${label} must not contain HTML`);
  return value;
}

export function validateEditorialContent(value) {
  const content = object(value, 'editorial content');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(content.id)) throw new Error('editorial id is invalid');
  if (content.version !== '1') throw new Error('editorial version is unsupported');
  if (!PILLARS.has(content.pillar)) throw new Error('editorial pillar is invalid');
  text(content.title, 'editorial title', 90);
  text(content.promise, 'editorial promise', 180);
  if (!Array.isArray(content.slides) || content.slides.length !== 7) {
    throw new Error('editorial content must contain seven slides');
  }
  content.slides.forEach((slide, index) => {
    object(slide, `slide ${index + 1}`);
    if (slide.kind !== SLIDE_KINDS[index]) throw new Error(`slide ${index + 1} has an invalid kind`);
    text(slide.title, `slide ${index + 1} title`, 90);
    if (slide.kind === 'example') {
      text(slide.before, 'example before', 220);
      text(slide.after, 'example after', 220);
    } else if (slide.kind === 'checklist') {
      if (!Array.isArray(slide.items) || slide.items.length !== 4) {
        throw new Error('checklist must contain four items');
      }
      slide.items.forEach((item, itemIndex) => text(item, `checklist item ${itemIndex + 1}`, 120));
    } else {
      text(slide.body, `slide ${index + 1} body`, 360);
    }
  });
  object(content.story, 'editorial story');
  text(content.story.eyebrow, 'story eyebrow', 40);
  text(content.story.title, 'story title', 90);
  text(content.story.body, 'story body', 220);
  object(content.caption, 'editorial caption');
  text(content.caption.hook, 'caption hook', 220);
  text(content.caption.action, 'caption action', 500);
  if (!Array.isArray(content.hashtags) || content.hashtags.length < 3 || content.hashtags.length > 8) {
    throw new Error('editorial hashtags must contain between three and eight entries');
  }
  content.hashtags.forEach((hashtag) => {
    if (!/^[\p{L}\p{N}_]+$/u.test(hashtag)) throw new Error('editorial hashtag is invalid');
  });
  if (!Array.isArray(content.sources) || content.sources.length === 0) {
    throw new Error('editorial content must have at least one source');
  }
  content.sources.forEach((source, index) => {
    object(source, `source ${index + 1}`);
    text(source.title, `source ${index + 1} title`, 180);
    text(source.author, `source ${index + 1} author`, 120);
    try {
      const url = new URL(source.url);
      if (url.protocol !== 'https:') throw new Error('not HTTPS');
    } catch {
      throw new Error(`source ${index + 1} URL is invalid`);
    }
  });
  if (!Number.isInteger(content.minRepeatDays) || content.minRepeatDays < 84) {
    throw new Error('editorial minRepeatDays must be at least 84');
  }
  return content;
}

export function validateEditorialCatalog(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('editorial catalog must be an array');
  const ids = new Set();
  value.forEach((content) => {
    validateEditorialContent(content);
    if (ids.has(content.id)) throw new Error(`duplicate editorial id: ${content.id}`);
    ids.add(content.id);
  });
  return value;
}
