import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { messagingApi, validateSignature } from '@line/bot-sdk';
import { createFakeLine, type FakeLine } from './server.js';
import {
  imageSetEvents,
  joinEvent,
  postWebhook,
  signBody,
  stickerEvent,
  textEvent,
  ulid,
  unsendEvent,
} from './webhook.js';

const G1 = 'C11111111111111111111111111111111';
const G2 = 'C22222222222222222222222222222222';
const DAY = 24 * 60 * 60 * 1000;

let fake: FakeLine;
let t: number;

function members(n: number, prefix: string) {
  return Array.from({ length: n }, (_, i) => ({ userId: `U${prefix}${i}`, displayName: `${prefix} ${i}` }));
}

interface LineJson {
  message?: string;
  details?: { message: string; property: string }[];
  sentMessages?: { id: string; quoteToken?: string }[];
  userId?: string;
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(fake.url + path, {
    method,
    headers: { authorization: 'Bearer test-token', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const isJson = text !== '' && (res.headers.get('content-type') ?? '').includes('json');
  const json: LineJson = isJson ? (JSON.parse(text) as LineJson) : {};
  return { status: res.status, headers: res.headers, json, text };
}

function push(to: string, messages: unknown[], retryKey?: string) {
  return call('POST', '/v2/bot/message/push', { to, messages }, retryKey ? { 'x-line-retry-key': retryKey } : {});
}

beforeEach(async () => {
  t = 1_700_000_000_000;
  fake = await createFakeLine({ channelSecret: 'secret', now: () => t, monthlyLimit: 100 });
  fake.addGroup({ groupId: G1, name: 'One', members: members(3, 'a') });
  fake.addGroup({ groupId: G2, name: 'Two', members: members(7, 'b') });
});

afterEach(async () => {
  await fake.close();
});

describe('auth and request ids', () => {
  it('rejects API calls without a bearer token and stamps every response with x-line-request-id', async () => {
    const res = await fetch(`${fake.url}/v2/bot/info`);
    expect(res.status).toBe(401);
    expect(res.headers.get('x-line-request-id')).toMatch(/^[0-9a-f]{32}$/);
    const ok = await call('GET', '/v2/bot/info');
    expect(ok.status).toBe(200);
    expect(ok.json.userId).toBe(fake.botUserId);
    expect(ok.headers.get('x-line-request-id')).not.toBe(res.headers.get('x-line-request-id'));
  });
});

describe('push and retry keys', () => {
  it('replays the original sentMessages with 409 when a retry key is reused within 24 h', async () => {
    const key = randomUUID();
    const first = await push(G1, [{ type: 'text', text: 'hi' }, { type: 'location', title: 't', address: 'a', latitude: 1, longitude: 2 }], key);
    expect(first.status).toBe(200);
    expect(first.json.sentMessages).toHaveLength(2);
    expect(first.json.sentMessages?.[0]?.quoteToken).toEqual(expect.any(String));
    expect(first.json.sentMessages?.[1]?.quoteToken).toBeUndefined();

    t += DAY - 1;
    const again = await push(G1, [{ type: 'text', text: 'hi' }], key);
    expect(again.status).toBe(409);
    expect(again.json).toEqual({ message: 'The retry key is already accepted', sentMessages: first.json.sentMessages });
    expect(again.headers.get('x-line-accepted-request-id')).toBe(first.headers.get('x-line-request-id'));
    expect(fake.delivered(G1)).toHaveLength(1);
    expect(fake.billed[G1]).toBe(3);

    t += 1;
    const expired = await push(G1, [{ type: 'text', text: 'hi' }], key);
    expect(expired.status).toBe(200);
    expect(fake.delivered(G1)).toHaveLength(2);
  });

  it('rejects non-UUID retry keys and does not remember keys of rejected requests', async () => {
    expect((await push(G1, [{ type: 'text', text: 'x' }], 'not-a-uuid')).status).toBe(400);
    const key = randomUUID();
    fake.injectFailure({ endpoint: 'push', status: 500, times: 1 });
    expect((await push(G1, [{ type: 'text', text: 'x' }], key)).status).toBe(500);
    expect((await push(G1, [{ type: 'text', text: 'x' }], key)).status).toBe(200);
    expect((await push(G1, [{ type: 'text', text: 'x' }], key)).status).toBe(409);
  });

  it('bills the member count per accepted push regardless of object count, and nothing for replies', async () => {
    await push(G1, [{ type: 'text', text: '1' }, { type: 'text', text: '2' }, { type: 'text', text: '3' }]);
    await push(G2, [{ type: 'text', text: '1' }]);
    await push(G2, [{ type: 'sticker', packageId: '1', stickerId: '1' }]);
    await push(G2, [{ type: 'text', text: '' }]);
    const token = fake.issueReplyToken(G1);
    expect((await call('POST', '/v2/bot/message/reply', { replyToken: token, messages: [{ type: 'text', text: 'r' }] })).status).toBe(200);
    expect(fake.billed).toEqual({ [G1]: 3, [G2]: 14 });
    expect(fake.consumption).toBe(17);
    expect((await call('GET', '/v2/bot/message/quota/consumption')).json).toEqual({ totalUsage: 17 });
    expect(fake.delivered(G1).map((d) => d.via)).toEqual(['push', 'reply']);
  });

  it('answers 429 with the monthly-limit text once consumption reaches the limit or the flag is set', async () => {
    fake.setConsumption(99);
    expect((await push(G1, [{ type: 'text', text: 'x' }])).status).toBe(200);
    const limited = await push(G1, [{ type: 'text', text: 'x' }]);
    expect(limited.status).toBe(429);
    expect(limited.json.message).toBe('You have reached your monthly limit.');

    fake.setConsumption(0);
    fake.setMonthlyLimitReached(true);
    expect((await push(G1, [{ type: 'text', text: 'x' }])).status).toBe(429);
    const token = fake.issueReplyToken(G1);
    expect((await call('POST', '/v2/bot/message/reply', { replyToken: token, messages: [{ type: 'text', text: 'r' }] })).status).toBe(200);
  });

  it('rejects pushes to unknown groups and groups the bot left', async () => {
    expect((await push('Cunknown', [{ type: 'text', text: 'x' }])).status).toBe(400);
    expect((await call('POST', `/v2/bot/group/${G2}/leave`)).status).toBe(200);
    expect((await push(G2, [{ type: 'text', text: 'x' }])).status).toBe(400);
    expect((await call('GET', `/v2/bot/group/${G2}/summary`)).status).toBe(404);
  });

  it('injects failures a fixed number of times and delays responses', async () => {
    fake.injectFailure({ endpoint: 'push', status: 429, times: 2 });
    expect((await push(G1, [{ type: 'text', text: 'x' }])).status).toBe(429);
    expect((await push(G1, [{ type: 'text', text: 'x' }])).status).toBe(429);
    expect((await push(G1, [{ type: 'text', text: 'x' }])).status).toBe(200);

    fake.setDelay(300, 'push');
    const ctrl = AbortSignal.timeout(50);
    await expect(
      fetch(`${fake.url}/v2/bot/message/push`, {
        method: 'POST',
        headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
        body: JSON.stringify({ to: G1, messages: [{ type: 'text', text: 'x' }] }),
        signal: ctrl,
      }),
    ).rejects.toThrow();
    expect((await call('GET', '/v2/bot/info')).status).toBe(200);
  });
});

describe('reply tokens', () => {
  it('accepts a token once, rejects reuse, retry keys, other and expired tokens', async () => {
    const msg = [{ type: 'text', text: 'r' }];
    const token = fake.issueReplyToken(G1);
    expect((await call('POST', '/v2/bot/message/reply', { replyToken: token, messages: msg }, { 'x-line-retry-key': randomUUID() })).status).toBe(400);
    expect((await call('POST', '/v2/bot/message/reply', { replyToken: token, messages: msg })).status).toBe(200);
    const reused = await call('POST', '/v2/bot/message/reply', { replyToken: token, messages: msg });
    expect(reused.status).toBe(400);
    expect(reused.json.message).toBe('Invalid reply token');
    expect((await call('POST', '/v2/bot/message/reply', { replyToken: 'bogus', messages: msg })).status).toBe(400);

    const fresh = fake.issueReplyToken(G2);
    t += 60_001;
    expect((await call('POST', '/v2/bot/message/reply', { replyToken: fresh, messages: msg })).status).toBe(400);
    expect(fake.delivered(G2)).toHaveLength(0);
  });

  it('keeps a token usable when the reply was rejected for invalid messages', async () => {
    const token = fake.issueReplyToken(G1);
    expect((await call('POST', '/v2/bot/message/reply', { replyToken: token, messages: [] })).status).toBe(400);
    expect((await call('POST', '/v2/bot/message/reply', { replyToken: token, messages: [{ type: 'text', text: 'ok' }] })).status).toBe(200);
  });

  it('accepts reply tokens of webhook events built with the fake', async () => {
    const ev = joinEvent({ groupId: G1, fake });
    expect((await call('POST', '/v2/bot/message/reply', { replyToken: ev.replyToken, messages: [{ type: 'text', text: 'hi' }] })).status).toBe(200);
  });
});

describe('message validation', () => {
  async function details(messages: unknown[], to = G1) {
    const res = await push(to, messages);
    expect(res.status).toBe(400);
    return res.json.details ?? [];
  }

  it('enforces 1–5 objects and the 5000 UTF-16 unit text limit', async () => {
    expect(await details([])).toEqual([expect.objectContaining({ property: 'messages' })]);
    expect(await details(Array.from({ length: 6 }, () => ({ type: 'text', text: 'x' })))).toHaveLength(1);
    expect((await push(G1, [{ type: 'text', text: '🍎'.repeat(2500) }])).status).toBe(200);
    expect((await details([{ type: 'text', text: `${'🍎'.repeat(2500)}a` }]))[0]?.property).toBe('messages[0].text');
    expect((await details([{ type: 'file', url: 'https://x' }]))[0]?.property).toBe('messages[0].type');
  });

  it('checks that emoji indexes point at $ placeholders', async () => {
    const emoji = { productId: '5ac1bfd5040ab15980c9b435', emojiId: '001' };
    expect((await push(G1, [{ type: 'text', text: 'a$b$', emojis: [{ index: 1, ...emoji }, { index: 3, ...emoji }] }])).status).toBe(200);
    expect(await details([{ type: 'text', text: 'a$b$', emojis: [{ index: 1, ...emoji }, { index: 2, ...emoji }] }])).toEqual([
      expect.objectContaining({ property: 'messages[0].emojis[1].index' }),
    ]);
    const tooMany = Array.from({ length: 21 }, (_, i) => ({ index: i, ...emoji }));
    expect((await details([{ type: 'text', text: '$'.repeat(21), emojis: tooMany }]))[0]?.property).toBe('messages[0].emojis');
  });

  it('checks sender name length, the forbidden word and the icon URL', async () => {
    const icon = 'https://media.example.com/a/b.png?v=1';
    expect((await push(G1, [{ type: 'text', text: 'x', sender: { name: 'a'.repeat(20), iconUrl: icon } }])).status).toBe(200);
    expect((await details([{ type: 'text', text: 'x', sender: { name: 'a'.repeat(21) } }]))[0]?.property).toBe('messages[0].sender.name');
    expect((await details([{ type: 'text', text: 'x', sender: { name: 'my Line pal' } }]))[0]?.property).toBe('messages[0].sender.name');
    expect((await details([{ type: 'text', text: 'x', sender: { name: 'ＬＩＮＥ' } }]))[0]?.property).toBe('messages[0].sender.name');
    for (const iconUrl of ['http://media.example.com/b.png', 'https://media.example.com/b.jpg']) {
      expect((await details([{ type: 'sticker', packageId: '1', stickerId: '2', sender: { iconUrl } }]))[0]?.property).toBe('messages[0].sender.iconUrl');
    }
  });

  it('scopes quote tokens to the group they were issued for', async () => {
    const sent = await push(G1, [{ type: 'text', text: 'orig' }]);
    const qt = sent.json.sentMessages?.[0]?.quoteToken;
    expect((await push(G1, [{ type: 'text', text: 'reply', quoteToken: qt }])).status).toBe(200);
    expect((await details([{ type: 'text', text: 'reply', quoteToken: qt }], G2))[0]).toEqual({
      message: 'Invalid quote token',
      property: 'messages[0].quoteToken',
    });

    const inbound = stickerEvent({ groupId: G2, userId: 'Ub0', packageId: '1', stickerId: '2', fake });
    const inboundToken = inbound.message?.quoteToken;
    expect((await push(G2, [{ type: 'sticker', packageId: '1', stickerId: '2', quoteToken: inboundToken }])).status).toBe(200);
    expect((await details([{ type: 'text', text: 'x', quoteToken: inboundToken }], G1))[0]?.property).toBe('messages[0].quoteToken');
    expect((await details([{ type: 'text', text: 'x', quoteToken: 'never-issued' }], G2))[0]?.property).toBe('messages[0].quoteToken');
  });

  it('requires https media URLs', async () => {
    expect(
      (await details([{ type: 'image', originalContentUrl: 'http://x/a.jpg', previewImageUrl: 'https://x/p.jpg' }]))[0]?.property,
    ).toBe('messages[0].originalContentUrl');
  });

  it('validate endpoints check shape without delivering', async () => {
    expect((await call('POST', '/v2/bot/message/validate/push', { messages: [{ type: 'text', text: 'ok' }] })).status).toBe(200);
    expect((await call('POST', '/v2/bot/message/validate/reply', { messages: [{ type: 'text', text: 'ok', sender: { name: 'LINE' } }] })).status).toBe(400);
    expect(fake.delivered(G1)).toHaveLength(0);
  });
});

describe('group and profile endpoints', () => {
  it('serves summary, member count and member profiles; 404 for non-members', async () => {
    expect((await call('GET', `/v2/bot/group/${G1}/summary`)).json).toEqual({ groupId: G1, groupName: 'One' });
    expect((await call('GET', `/v2/bot/group/${G2}/members/count`)).json).toEqual({ count: 7 });
    expect((await call('GET', `/v2/bot/group/${G1}/member/Ua1`)).json).toEqual({ userId: 'Ua1', displayName: 'a 1' });
    expect((await call('GET', `/v2/bot/group/${G1}/member/Ub1`)).status).toBe(404);
    fake.removeMember(G1, 'Ua1');
    expect((await call('GET', `/v2/bot/group/${G1}/member/Ua1`)).status).toBe(404);
  });
});

describe('content', () => {
  it('answers 202 while transcoding, then serves the content after the configured polls', async () => {
    fake.setContent('m1', { contentType: 'video/mp4', data: Buffer.from('VIDEO'), preview: Buffer.from('JPG'), transcodePolls: 2 });
    expect((await call('GET', '/v2/bot/message/m1/content')).status).toBe(202);
    expect((await call('GET', '/v2/bot/message/m1/content/transcoding')).json).toEqual({ status: 'processing' });
    expect((await call('GET', '/v2/bot/message/m1/content')).status).toBe(202);
    expect((await call('GET', '/v2/bot/message/m1/content/transcoding')).json).toEqual({ status: 'processing' });
    expect((await call('GET', '/v2/bot/message/m1/content/transcoding')).json).toEqual({ status: 'succeeded' });
    const ready = await call('GET', '/v2/bot/message/m1/content');
    expect(ready.status).toBe(200);
    expect(ready.headers.get('content-type')).toBe('video/mp4');
    expect(ready.text).toBe('VIDEO');
    const preview = await call('GET', '/v2/bot/message/m1/content/preview');
    expect(preview.headers.get('content-type')).toBe('image/jpeg');
    expect(preview.text).toBe('JPG');
  });

  it('reports failed transcoding, 404 for unknown and 410 for expired content', async () => {
    fake.setContent('bad', { contentType: 'video/mp4', data: Buffer.alloc(1), failTranscode: true });
    expect((await call('GET', '/v2/bot/message/bad/content/transcoding')).json).toEqual({ status: 'failed' });
    expect((await call('GET', '/v2/bot/message/nope/content')).status).toBe(404);
    fake.setContent('old', { contentType: 'image/jpeg', data: Buffer.alloc(1), expired: true });
    for (const suffix of ['', '/preview', '/transcoding']) {
      expect((await call('GET', `/v2/bot/message/old/content${suffix}`)).status).toBe(410);
    }
  });
});

describe('SDK compatibility', () => {
  it('works with the official messaging clients, including the body-less leave call', async () => {
    const client = new messagingApi.MessagingApiClient({ channelAccessToken: 'tok', baseURL: fake.url });
    const key = randomUUID();
    const res = await client.pushMessageWithHttpInfo({ to: G1, messages: [{ type: 'text', text: 'hello' }] }, key);
    expect(res.body.sentMessages).toHaveLength(1);
    expect(fake.delivered(G1)[0]).toMatchObject({ via: 'push', retryKey: key, messages: [{ type: 'text', text: 'hello' }] });
    expect(fake.requests.at(-1)).toMatchObject({ method: 'POST', path: '/v2/bot/message/push', status: 200, at: t });
    expect((await client.getGroupMemberCount(G2)).count).toBe(7);
    await client.leaveGroup(G2);
    expect((await push(G2, [{ type: 'text', text: 'x' }])).status).toBe(400);

    fake.setContent('img', { contentType: 'image/png', data: Buffer.from([1, 2, 3]) });
    const blob = new messagingApi.MessagingApiBlobClient({ channelAccessToken: 'tok', baseURL: fake.url });
    const stream = await blob.getMessageContent('img');
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.from(c as Uint8Array));
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3]));
  });
});

describe('webhook helpers', () => {
  let server: Server;
  let received: { headers: Record<string, unknown>; raw: string }[];
  let hookUrl: string;

  beforeEach(async () => {
    received = [];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        received.push({ headers: req.headers, raw });
        const ok = validateSignature(raw, 'secret', String(req.headers['x-line-signature']));
        res.writeHead(ok ? 200 : 401).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    hookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('signs bodies exactly like the SDK verifies them', () => {
    const raw = JSON.stringify({ destination: 'U1', events: [textEvent({ groupId: G1, text: 'héllo 🍎' })] });
    expect(validateSignature(raw, 'secret', signBody('secret', raw))).toBe(true);
    expect(validateSignature(`${raw} `, 'secret', signBody('secret', raw))).toBe(false);
    expect(validateSignature(raw, 'other', signBody('secret', raw))).toBe(false);
  });

  it('posts signed batches, redeliveries and bad signatures', async () => {
    const ev = textEvent({ groupId: G1, userId: 'Ua0', text: 'hi' });
    expect(await postWebhook(hookUrl, 'secret', { destination: 'Ubot', events: [ev, unsendEvent({ groupId: G1, messageId: ev.message!.id })] })).toBe(200);
    expect(await postWebhook(hookUrl, 'secret', { destination: 'Ubot', events: [ev] }, { redelivery: true })).toBe(200);
    expect(await postWebhook(hookUrl, 'secret', { destination: 'Ubot', events: [] }, { signature: 'forged' })).toBe(401);
    const redelivered = JSON.parse(received[1]!.raw).events[0];
    expect(redelivered).toEqual({ ...ev, deliveryContext: { isRedelivery: true } });
    expect(ev.deliveryContext?.isRedelivery).toBe(false);
  });

  it('emits a leave webhook when the bot leaves through the API', async () => {
    const withHook = await createFakeLine({ channelSecret: 'secret', webhookUrl: hookUrl });
    try {
      withHook.addGroup({ groupId: G1, name: 'One', members: [] });
      const res = await fetch(`${withHook.url}/v2/bot/group/${G1}/leave`, { method: 'POST', headers: { authorization: 'Bearer x' } });
      expect(res.status).toBe(200);
      await expect.poll(() => received.length).toBe(1);
      const body = JSON.parse(received[0]!.raw);
      expect(body.destination).toBe(withHook.botUserId);
      expect(body.events[0]).toMatchObject({ type: 'leave', source: { type: 'group', groupId: G1 } });
      expect(body.events[0].replyToken).toBeUndefined();
    } finally {
      await withHook.close();
    }
  });

  it('builds realistic events', () => {
    const ev = textEvent({ groupId: G1, userId: 'Ua0', text: '@bob hi', mentionees: [{ index: 0, length: 4, userId: 'Ub' }], timestamp: 1_700_000_000_123 });
    expect(ev).toMatchObject({
      type: 'message',
      mode: 'active',
      timestamp: 1_700_000_000_123,
      source: { type: 'group', groupId: G1, userId: 'Ua0' },
      deliveryContext: { isRedelivery: false },
      message: { type: 'text', text: '@bob hi', mention: { mentionees: [{ index: 0, length: 4, type: 'user', userId: 'Ub' }] } },
    });
    expect(ev.webhookEventId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ev.webhookEventId.slice(0, 10)).toBe(ulid(1_700_000_000_123).slice(0, 10));
    expect(ev.replyToken).toEqual(expect.any(String));
    expect(ev.message?.quoteToken).toEqual(expect.any(String));
    expect(textEvent({ groupId: G1, text: 'x' }).source).toEqual({ type: 'group', groupId: G1 });

    const set = imageSetEvents({ groupId: G1, userId: 'Ua0', count: 5 });
    expect(set.map((e) => e.message?.imageSet?.index).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(set.map((e) => e.message?.imageSet?.id)).size).toBe(1);
  });
});
