const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

async function readJson(url, apiKey) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', authorization: `Key ${apiKey}` },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`OneSignal audit request failed with status ${response.status}`);
  return response.json();
}

async function main() {
  const appId = process.env.ONESIGNAL_APP_ID;
  const apiKey = process.env.ONESIGNAL_API_KEY;
  const messageId = process.env.REFERENCE_MESSAGE_ID;
  if (!UUID.test(appId ?? '') || !UUID.test(messageId ?? '') || !apiKey) throw new Error('OneSignal audit input is invalid');
  const message = await readJson(`https://api.onesignal.com/notifications/${messageId}?app_id=${appId}`, apiKey);
  const segmentList = await readJson(`https://api.onesignal.com/apps/${appId}/segments`, apiKey);
  const segments = [];
  for (const segment of segmentList.segments ?? []) {
    if (!UUID.test(segment?.id ?? '')) continue;
    const detail = await readJson(`https://api.onesignal.com/apps/${appId}/segments/${segment.id}`, apiKey);
    segments.push({ name: segment.name, subscriberCount: detail.subscriber_count });
  }
  console.log(JSON.stringify({
    message: {
      appIdMatches: message.app_id === appId,
      filters: Array.isArray(message.filters) ? message.filters : null,
      includedSegments: Array.isArray(message.included_segments) ? message.included_segments : null,
      successful: Number.isInteger(message.successful) ? message.successful : null,
    },
    segments,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'OneSignal audit failed');
  process.exitCode = 1;
});
