import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readPushConfig } from '../modules/push/push-config.mjs';
import { sendOneSignalPush } from '../modules/push/onesignal-client.mjs';

function deterministicUuid(value) {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function sendVersionAnnouncement({
  confirmation,
  operationKey,
  env = process.env,
  now = new Date().toISOString(),
  send = sendOneSignalPush,
  log = console.log,
}) {
  if (confirmation !== 'BROADCAST_VERSION_ANNOUNCEMENT') throw new Error('Version announcement requires the exact confirmation phrase');
  if (!/^job-push-[1-9][0-9]*-[1-9][0-9]*$/u.test(operationKey ?? '')) throw new Error('Version announcement operation key is invalid');
  const config = readPushConfig(env, { now });
  const result = await send({
    idempotencyKey: deterministicUuid(`openings-version-announcement:${operationKey}`),
    payload: {
      headings: { en: 'Nova versão do Openings' },
      contents: { en: 'Uma nova versão do Openings está disponível. Atualize agora para ter as últimas melhorias.' },
      data: { type: 'version_announcement' },
    },
  }, config);
  if (result.status !== 'accepted') throw new Error(`Version announcement was not accepted: ${result.status}`);
  const summary = { outcome: 'accepted', notificationId: result.notificationId };
  log(JSON.stringify(summary));
  return summary;
}

async function main() {
  const confirmationIndex = process.argv.indexOf('--confirmation');
  const confirmation = confirmationIndex >= 0 ? process.argv[confirmationIndex + 1] : '';
  await sendVersionAnnouncement({ confirmation, operationKey: process.env.PUSH_OPERATION_KEY });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Version announcement failed');
    process.exitCode = 1;
  });
}
