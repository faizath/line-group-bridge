import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import yaml from 'yaml';
import { translator } from '../../src/i18n/index.js';
import { translate } from '../../src/translate/translate.js';
import type { TranslateContext } from '../../src/translate/types.js';
import {
  audioEvent,
  editEvent,
  fileEvent,
  imageEvent,
  joinEvent,
  leaveEvent,
  locationEvent,
  memberJoinedEvent,
  memberLeftEvent,
  postbackEvent,
  stickerEvent,
  textEvent,
  unsendEvent,
  videoEvent,
} from '../fake-line/webhook.js';

interface SchemaDoc {
  components: {
    schemas: Record<string, Record<string, unknown>>;
  };
}

const webhookDoc = yaml.parse(readFileSync('test/fixtures/openapi/webhook.yml', 'utf8')) as SchemaDoc;
const messagingDoc = yaml.parse(readFileSync('test/fixtures/openapi/messaging-api.yml', 'utf8')) as SchemaDoc;

describe('OpenAPI contract validation (NFR-MAINT-1, PRD/13 §1)', () => {
  describe('webhook fixtures match webhook.yml', () => {
    function assertRequiredProperties(obj: Record<string, unknown>, schemaName: string) {
      const schema = webhookDoc.components.schemas[schemaName];
      expect(schema, `Schema ${schemaName} not found in webhook.yml`).toBeDefined();
      const required = (schema?.['required'] as string[]) ?? [];
      for (const field of required) {
        expect(obj[field], `Field ${field} required by ${schemaName}`).toBeDefined();
      }
    }

    it('MessageEvent with text content', () => {
      const ev = textEvent({ groupId: 'G1', userId: 'U1', text: 'hello' });
      assertRequiredProperties(ev, 'MessageEvent');
      assertRequiredProperties(ev.message as Record<string, unknown>, 'TextMessageContent');
      expect(ev.type).toBe('message');
      expect(ev.message?.type).toBe('text');
    });

    it('MessageEvent with image content', () => {
      const ev = imageEvent({ groupId: 'G1', userId: 'U1' });
      assertRequiredProperties(ev, 'MessageEvent');
      assertRequiredProperties(ev.message as Record<string, unknown>, 'ImageMessageContent');
    });

    it('MessageEvent with video content', () => {
      const ev = videoEvent({ groupId: 'G1', userId: 'U1', duration: 12000 });
      assertRequiredProperties(ev, 'MessageEvent');
      assertRequiredProperties(ev.message as Record<string, unknown>, 'VideoMessageContent');
    });

    it('MessageEvent with audio content', () => {
      const ev = audioEvent({ groupId: 'G1', userId: 'U1', duration: 4500 });
      assertRequiredProperties(ev, 'MessageEvent');
      assertRequiredProperties(ev.message as Record<string, unknown>, 'AudioMessageContent');
    });

    it('MessageEvent with file content', () => {
      const ev = fileEvent({ groupId: 'G1', fileName: 'doc.pdf', fileSize: 1024 });
      assertRequiredProperties(ev, 'MessageEvent');
      assertRequiredProperties(ev.message as Record<string, unknown>, 'FileMessageContent');
    });

    it('MessageEvent with location content', () => {
      const ev = locationEvent({ groupId: 'G1', address: 'Tokyo', latitude: 35.6, longitude: 139.7 });
      assertRequiredProperties(ev, 'MessageEvent');
      assertRequiredProperties(ev.message as Record<string, unknown>, 'LocationMessageContent');
    });

    it('MessageEvent with sticker content', () => {
      const ev = stickerEvent({ groupId: 'G1', packageId: '446', stickerId: '1988' });
      assertRequiredProperties(ev, 'MessageEvent');
      assertRequiredProperties(ev.message as Record<string, unknown>, 'StickerMessageContent');
    });

    it('MessageEditedEvent', () => {
      const ev = editEvent({ groupId: 'G1', id: 'm1', text: 'edited' });
      assertRequiredProperties(ev, 'MessageEditedEvent');
      expect(ev.type).toBe('messageEdited');
    });

    it('UnsendEvent', () => {
      const ev = unsendEvent({ groupId: 'G1', messageId: 'm1' });
      assertRequiredProperties(ev, 'UnsendEvent');
      expect(ev.type).toBe('unsend');
    });

    it('JoinEvent & LeaveEvent', () => {
      const join = joinEvent({ groupId: 'G1' });
      assertRequiredProperties(join, 'JoinEvent');
      const leave = leaveEvent({ groupId: 'G1' });
      assertRequiredProperties(leave, 'LeaveEvent');
    });

    it('MemberJoinedEvent & MemberLeftEvent', () => {
      const joined = memberJoinedEvent({ groupId: 'G1', userIds: ['U1', 'U2'] });
      assertRequiredProperties(joined, 'MemberJoinedEvent');
      const left = memberLeftEvent({ groupId: 'G1', userIds: ['U1'] });
      assertRequiredProperties(left, 'MemberLeftEvent');
    });

    it('PostbackEvent', () => {
      const pb = postbackEvent({ groupId: 'G1', data: 'action=ok' });
      assertRequiredProperties(pb, 'PostbackEvent');
    });
  });

  describe('outbound messages match messaging-api.yml', () => {
    function assertRequiredOutbound(msg: Record<string, unknown>, schemaName: string) {
      const schema = messagingDoc.components.schemas[schemaName];
      expect(schema, `Schema ${schemaName} not found in messaging-api.yml`).toBeDefined();
      const required = (schema?.['required'] as string[]) ?? [];
      for (const field of required) {
        expect(msg[field], `Field ${field} required by ${schemaName}`).toBeDefined();
      }
    }

    const t = translator('en');
    const ctx: TranslateContext = {
      bridge: { name: 'Bridge', originTagStyle: 'name_suffix', iconUrl: 'https://media.example/b.png' },
      originGroup: { shortTag: 'A' },
      author: { displayName: 'Alice', iconUrl: 'https://media.example/a.png' },
      quote: null,
      media: {
        originalUrl: 'https://media.example/orig.jpg',
        previewUrl: 'https://media.example/prev.jpg',
        durationMs: 5000,
        linkUrl: 'https://media.example/file.pdf',
      },
      isStickerSendable: () => true,
      fallbackStep: 0,
      forbiddenWords: ['LINE'],
      targetMemberIds: new Set(['Uco']),
      t,
    };

    it('TextMessage', () => {
      const msgs = translate({ messageId: '1', type: 'text', text: 'hi', meta: {} }, ctx, 'relay');
      assertRequiredOutbound(msgs[0] as unknown as Record<string, unknown>, 'TextMessage');
      assertRequiredOutbound(msgs[0]?.sender as unknown as Record<string, unknown>, 'Sender');
    });

    it('TextMessageV2', () => {
      const msgs = translate(
        {
          messageId: '1',
          type: 'text',
          text: 'hi @User',
          meta: { mentionees: [{ index: 3, length: 5, type: 'user', userId: 'Uco' }] },
        },
        ctx,
        'relay',
      );
      assertRequiredOutbound(msgs[0] as unknown as Record<string, unknown>, 'TextMessageV2');
    });

    it('StickerMessage', () => {
      const msgs = translate(
        { messageId: '1', type: 'sticker', text: null, meta: { sticker: { packageId: '446', stickerId: '1988' } } },
        ctx,
        'relay',
      );
      assertRequiredOutbound(msgs[0] as unknown as Record<string, unknown>, 'StickerMessage');
    });

    it('ImageMessage', () => {
      const msgs = translate({ messageId: '1', type: 'image', text: null, meta: {} }, ctx, 'relay');
      assertRequiredOutbound(msgs[0] as unknown as Record<string, unknown>, 'ImageMessage');
    });

    it('VideoMessage', () => {
      const msgs = translate({ messageId: '1', type: 'video', text: null, meta: {} }, ctx, 'relay');
      assertRequiredOutbound(msgs[0] as unknown as Record<string, unknown>, 'VideoMessage');
    });

    it('AudioMessage', () => {
      const msgs = translate({ messageId: '1', type: 'audio', text: null, meta: {} }, ctx, 'relay');
      assertRequiredOutbound(msgs[0] as unknown as Record<string, unknown>, 'AudioMessage');
    });

    it('LocationMessage', () => {
      const msgs = translate(
        { messageId: '1', type: 'location', text: null, meta: { location: { title: 'T', address: 'A', latitude: 10, longitude: 20 } } },
        ctx,
        'relay',
      );
      assertRequiredOutbound(msgs[0] as unknown as Record<string, unknown>, 'LocationMessage');
    });
  });
});
