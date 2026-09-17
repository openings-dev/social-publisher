import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const repositoryRoot = new URL('../', import.meta.url);
const workflow = readFileSync(
  new URL('.github/workflows/configure-onesignal-fcm.yml', repositoryRoot),
  'utf8',
);

function step(workflowText, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return workflowText.match(new RegExp(
    `^      - name: ${escaped}(?<block>[\\s\\S]*?)(?=^      - name:|(?![\\s\\S]))`,
    'mu',
  ))?.groups?.block ?? '';
}

test('is a manual main-only read-only FCM bootstrap workflow', () => {
  assert.match(workflow, /^on:\n  workflow_dispatch:/mu);
  for (const trigger of ['schedule', 'repository_dispatch', 'push']) {
    assert.doesNotMatch(workflow, new RegExp(`^  ${trigger}:`, 'mu'));
  }
  assert.match(workflow, /^permissions:\n  contents: read$/mu);
  assert.match(workflow, /^    if: github\.ref == 'refs\/heads\/main'$/mu);
  assert.match(workflow, /^    timeout-minutes: 5$/mu);
});

test('scopes FCM secrets to the configuration step without printing or persisting them', () => {
  const configureStep = step(workflow, 'Configure and verify OneSignal FCM v1');
  const mappings = {
    ONESIGNAL_ORGANIZATION_API_KEY: 'secrets.ONESIGNAL_ORGANIZATION_API_KEY',
    ONESIGNAL_FCM_SERVICE_ACCOUNT_JSON: 'secrets.ONESIGNAL_FCM_SERVICE_ACCOUNT_JSON',
    ONESIGNAL_APP_ID: 'secrets.ONESIGNAL_APP_ID',
    REQUEST_CONFIRMATION: 'inputs.confirmation',
  };

  for (const [name, source] of Object.entries(mappings)) {
    assert.equal([...workflow.matchAll(new RegExp(`${name}:`, 'gu'))].length, 1);
    assert.match(configureStep, new RegExp(`^          ${name}: \\$\\{\\{ ${source.replace('.', '\\.') } \\}\\}$`, 'mu'));
  }

  const jobBeforeSteps = workflow.match(/^  configure:\n(?<block>[\s\S]*?)^    steps:/mu)?.groups?.block ?? '';
  assert.doesNotMatch(jobBeforeSteps,
    /ONESIGNAL_(?:ORGANIZATION_API_KEY|FCM_SERVICE_ACCOUNT_JSON|APP_ID)|REQUEST_CONFIRMATION/u);
  assert.doesNotMatch(workflow, /add-mask|echo\s+.*(?:ONESIGNAL_|REQUEST_CONFIRMATION)|upload-artifact|artifact/iu);
});

test('only configures FCM and cannot enable or send pushes', () => {
  assert.match(workflow, /^        run: npm run push:configure-fcm$/mu);
  assert.doesNotMatch(workflow, /npm run push --|OPENINGS_PUSH_AUTO_PUBLISH|SEND_TEST_PUSH|ENABLE_NEW_JOB_PUSH/u);
});
