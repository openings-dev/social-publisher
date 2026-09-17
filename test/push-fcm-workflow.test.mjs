import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const repositoryRoot = new URL('../', import.meta.url);
const workflow = readFileSync(
  new URL('.github/workflows/configure-onesignal-fcm.yml', repositoryRoot),
  'utf8',
);

function stepBlock(workflowText, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return workflowText.match(new RegExp(
    `^      - name: ${escaped}\\n[\\s\\S]*?(?=^      - name:|(?![\\s\\S]))`,
    'mu',
  ))?.[0] ?? '';
}

function step(workflowText, name) {
  const block = stepBlock(workflowText, name);
  return block.slice(block.indexOf('\n') + 1);
}

function runValues(workflowText) {
  const lines = workflowText.split('\n');
  const values = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(?<indent>\s*)run:\s*(?<value>.*)$/u);
    if (!match) continue;

    const { indent, value } = match.groups;
    if (!/^[>|][+-]?$/u.test(value)) {
      values.push(value);
      continue;
    }

    const blockIndent = `${indent}  `;
    const block = [];
    index += 1;
    while (index < lines.length && (lines[index] === '' || lines[index].startsWith(blockIndent))) {
      if (lines[index] !== '') block.push(lines[index].slice(blockIndent.length));
      index += 1;
    }
    index -= 1;
    values.push(block.join('\n'));
  }

  return values;
}

test('is a manual main-only read-only FCM bootstrap workflow', () => {
  assert.match(workflow, /^on:\n  workflow_dispatch:/mu);
  assert.match(workflow, /^on:\n  workflow_dispatch:\n    inputs:\n      confirmation:\n        description: Enter CONFIGURE_OPENINGS_FCM_V1 exactly\n        required: true\n        type: string$/mu);
  for (const trigger of ['schedule', 'repository_dispatch', 'push']) {
    assert.doesNotMatch(workflow, new RegExp(`^  ${trigger}:`, 'mu'));
  }
  assert.match(workflow, /^permissions:\n  contents: read$/mu);
  assert.match(workflow, /^    if: github\.ref == 'refs\/heads\/main'$/mu);
  assert.match(workflow, /^    timeout-minutes: 5$/mu);
});

test('uses the reviewed runner, pinned actions, and locked dependency install', () => {
  assert.match(workflow, /^    runs-on: ubuntu-latest$/mu);
  assert.match(step(workflow, 'Check out the trusted bootstrap code'),
    /^        uses: actions\/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5$/mu);
  const setupNode = step(workflow, 'Use Node.js 20');
  assert.match(setupNode, /^        uses: actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020$/mu);
  assert.match(setupNode, /^          node-version: 20$/mu);
  assert.match(setupNode, /^          cache: npm$/mu);
  assert.equal(step(workflow, 'Install exact dependencies').trim(), 'run: npm ci');
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

  const workflowWithoutConfigureStep = workflow.replace(
    stepBlock(workflow, 'Configure and verify OneSignal FCM v1'),
    '',
  );
  for (const name of ['ONESIGNAL_ORGANIZATION_API_KEY', 'ONESIGNAL_FCM_SERVICE_ACCOUNT_JSON', 'ONESIGNAL_APP_ID']) {
    assert.doesNotMatch(workflowWithoutConfigureStep, new RegExp(`\\$\\{\\{ secrets\\.${name} \\}\\}|${name}`, 'u'));
  }
});

test('only configures FCM and cannot enable or send pushes', () => {
  assert.match(workflow, /^        run: npm run push:configure-fcm$/mu);
  assert.deepEqual(runValues(workflow), ['npm ci', 'npm run push:configure-fcm']);
  assert.doesNotMatch(workflow, /npm run push --|OPENINGS_PUSH_AUTO_PUBLISH|SEND_TEST_PUSH|ENABLE_NEW_JOB_PUSH/u);
});
