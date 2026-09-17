import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { configureOneSignalFcm } from '../modules/push/onesignal-fcm-configurator.mjs';

const CONFIRMATION = 'CONFIGURE_OPENINGS_FCM_V1';

export async function runOneSignalFcmBootstrap({
  env = process.env,
  log = console.log,
  configure = configureOneSignalFcm,
} = {}) {
  if (env.REQUEST_CONFIRMATION !== CONFIRMATION) {
    throw new Error('OneSignal FCM bootstrap requires the exact confirmation phrase');
  }

  const result = await configure({
    appId: env.ONESIGNAL_APP_ID,
    organizationApiKey: env.ONESIGNAL_ORGANIZATION_API_KEY?.replace(/[\r\n]/gu, ''),
    serviceAccountJson: env.ONESIGNAL_FCM_SERVICE_ACCOUNT_JSON,
  });

  log(`OneSignal FCM v1 configured for ${result.appId}`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runOneSignalFcmBootstrap().catch((error) => {
    console.error(error instanceof Error && typeof error.message === 'string'
      ? error.message
      : 'OneSignal FCM bootstrap failed');
    process.exitCode = 1;
  });
}
