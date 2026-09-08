import { resolve } from 'node:path';
import { claimMastodonOwnership } from '../modules/publishing/platform-mastodon.mjs';
import { loadStateFile } from '../modules/state/load-state.mjs';
import { saveStateFile } from '../modules/state/save-state.mjs';
import { migrateQueueState, validateQueueState } from '../modules/state/state-model.mjs';

if (process.env.PUBLISHING_MASTODON_ENABLED !== 'true') throw new Error('Cloudflare Mastodon ownership is disabled');
if (process.argv.length !== 2) throw new Error('This command only operates on the current publisher state');
const path = resolve('state/queue.json');
const queue = await loadStateFile(path, validateQueueState, migrateQueueState);
await saveStateFile(path, claimMastodonOwnership(queue), validateQueueState);
