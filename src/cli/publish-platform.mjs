import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareSocialPublication, submitSocialPublication } from '../modules/publishing/platform-publisher.mjs';

export async function runPlatformCommand(args, env = process.env) {
  const [command, ...values] = args;
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    if (!['--job', '--media', '--outbox', '--handoff'].includes(name)
      || !values[index + 1] || values[index + 1].startsWith('--') || options[name]) {
      throw new Error('Invalid platform command arguments');
    }
    options[name] = values[index + 1];
  }
  if (command === 'prepare' && options['--job'] && options['--media'] && !options['--handoff']) {
    const prepared = await prepareSocialPublication({
      job: JSON.parse(await readFile(resolve(options['--job']), 'utf8')),
      mediaPath: resolve(options['--media']), outboxDirectory: resolve(options['--outbox'] ?? '.publishing/outbox'),
    });
    return { outcome: 'prepared', path: prepared.path };
  }
  if (command === 'submit' && options['--handoff'] && Object.keys(options).length === 1) {
    if (env.PUBLISHING_SOCIAL_SHADOW_ENABLED !== 'true') throw new Error('Social shadow submission is disabled');
    return submitSocialPublication({ path: resolve(options['--handoff']), transport: {
      baseUrl: env.PUBLISHING_ENDPOINT, clientId: env.PUBLISHING_CLIENT_ID, secret: env.PUBLISHING_CLIENT_SECRET,
      fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(60_000) }),
    } });
  }
  throw new Error('Use prepare --job FILE --media PNG or submit --handoff FILE');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runPlatformCommand(process.argv.slice(2)).then(result => {
    console.log(JSON.stringify(result));
    if (result.outcome === 'retry-later') process.exitCode = 75;
  }).catch(() => {
    console.error('Platform operation failed; retained local handoff for retry. Check configuration and media.');
    process.exitCode = 1;
  });
}
