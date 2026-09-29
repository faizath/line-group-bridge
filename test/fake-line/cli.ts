// Standalone fake LINE for manual runs and the load test:
//   tsx test/fake-line/cli.ts --port 9000 --secret xyz --webhook http://localhost:8080/webhook
// Set up groups and inspect deliveries over the `/__fake/*` control API.

import { parseArgs } from 'node:util';
import { createLogger } from '../../src/logger.js';
import { createFakeLine } from './server.js';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '9000' },
    host: { type: 'string', default: '127.0.0.1' },
    secret: { type: 'string' },
    'bot-user-id': { type: 'string' },
    webhook: { type: 'string' },
    'reply-token-ttl-ms': { type: 'string' },
    'monthly-limit': { type: 'string' },
    'record-limit': { type: 'string', default: '10000' },
  },
  strict: true,
});

function intArg(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer, got ${raw}`);
  return n;
}

const log = createLogger('info');
const fake = await createFakeLine({
  port: intArg('port', values.port),
  host: values.host,
  channelSecret: values.secret,
  botUserId: values['bot-user-id'],
  webhookUrl: values.webhook,
  replyTokenTtlMs: intArg('reply-token-ttl-ms', values['reply-token-ttl-ms']),
  monthlyLimit: intArg('monthly-limit', values['monthly-limit']) ?? null,
  recordLimit: intArg('record-limit', values['record-limit']),
});
log.info({ url: fake.url, botUserId: fake.botUserId, webhook: values.webhook ?? null }, `fake LINE listening on ${fake.url}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void fake.close().then(() => process.exit(0));
  });
}
