import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const repositoryRoot = new URL('../', import.meta.url);
const workflow = readFileSync(
  new URL('.github/workflows/publish-push.yml', repositoryRoot),
  'utf8',
);

function step(workflowText, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return workflowText.match(new RegExp(
    `^      - name: ${escaped}(?<block>[\\s\\S]*?)(?=^      - name:|(?![\\s\\S]))`,
    'mu',
  ))?.groups?.block ?? '';
}

test('resuming a pending push does not fail when its intent is already saved', () => {
  const checkpoint = step(workflow, 'Checkpoint push intent before the provider request');
  const add = checkpoint.indexOf('add -- state/push.json');
  const noChangeGuard = checkpoint.indexOf('diff --cached --quiet; then exit 0; fi');
  const commit = checkpoint.indexOf("commit -m 'chore(state): record push intent [skip ci]'");

  assert.ok(add >= 0 && add < noChangeGuard && noChangeGuard < commit);
});
