const TERMINAL = new Set(['completed', 'skipped']);
const KNOWN = new Set(['pending', 'accepted', 'completed', 'ambiguous', 'skipped']);

function invalid() {
  throw new Error('Invalid Openings R2 retention state');
}

export function planOpeningsR2Cleanup(manifest, { maxObjects, maxBytes }) {
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.files)
    || !Number.isSafeInteger(maxObjects) || maxObjects < 1
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1) invalid();
  const eligible = [];
  for (const file of manifest.files) {
    if (!file || typeof file !== 'object' || typeof file.objectKey !== 'string'
      || !Number.isSafeInteger(file.byteSize) || file.byteSize < 1 || !Array.isArray(file.consumers)) invalid();
    if (file.consumers.some((consumer) => !consumer || !KNOWN.has(consumer.state))) invalid();
    if (file.uploadState === 'verified' && file.consumers.length > 0
      && file.consumers.every((consumer) => TERMINAL.has(consumer.state))) eligible.push(file);
  }
  const objectKeys = [];
  let totalBytes = 0;
  for (const file of eligible) {
    if (objectKeys.length >= maxObjects || totalBytes + file.byteSize > maxBytes) break;
    objectKeys.push(file.objectKey);
    totalBytes += file.byteSize;
  }
  return { objectKeys, totalBytes, truncated: objectKeys.length < eligible.length };
}
