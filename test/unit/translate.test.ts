import { describe, expect, it } from 'vitest';
import { translator } from '../../src/i18n/index.js';
import { noticeMessage, senderName, snippetFor, translate } from '../../src/translate/translate.js';
import type { OriginForTranslate, TranslateContext } from '../../src/translate/types.js';

const t = translator('en');

const baseContext: TranslateContext = {
  bridge: { name: 'Alumni Bridge', originTagStyle: 'name_suffix', iconUrl: 'https://media.example/default.png' },
  originGroup: { shortTag: 'A' },
  author: { displayName: 'Alice', iconUrl: 'https://media.example/alice.png' },
  quote: null,
  media: null,
  isStickerSendable: (pkg, id) => pkg === '446' && id === '1988',
  fallbackStep: 0,
  forbiddenWords: ['LINE'],
  targetMemberIds: new Set(['Uknown']),
  t,
};

describe('translate module', () => {
  describe('senderName', () => {
    it('formats with name_suffix tag', () => {
      const name = senderName('Ken', 'B', 'name_suffix', ['LINE'], t);
      expect(name).toBe('Ken·B');
      expect(name.length).toBeLessThanOrEqual(20);
    });

    it('formats with none or text_prefix style', () => {
      expect(senderName('Ken', 'B', 'none', ['LINE'], t)).toBe('Ken');
      expect(senderName('Ken', 'B', 'text_prefix', ['LINE'], t)).toBe('Ken');
    });

    it('falls back to LINE user for null/empty names and sanitizes forbidden words', () => {
      expect(senderName(null, 'B', 'name_suffix', ['LINE'], t)).toBe('L1NE user·B');
      expect(senderName('   ', 'B', 'none', ['LINE'], t)).toBe('L1NE user');
    });

    it('sanitizes forbidden words case-insensitively', () => {
      const name = senderName('LINE Admin', 'A', 'none', ['LINE'], t);
      expect(name.toLowerCase()).not.toContain('line');
      expect(name).toBe('L1NE Admin');
    });

    it('truncates name to <= 20 UTF-16 units without cutting surrogates', () => {
      const longName = 'Alice'.repeat(5); // 25 chars
      const name = senderName(longName, 'A', 'name_suffix', ['LINE'], t);
      expect(name.length).toBeLessThanOrEqual(20);
      expect(name.endsWith('·A')).toBe(true);

      const emojiName = '🍎🍎🍎🍎🍎🍎🍎🍎🍎🍎'; // 20 units
      const name2 = senderName(emojiName, 'A', 'name_suffix', ['LINE'], t);
      expect(name2.length).toBeLessThanOrEqual(20);
      expect(name2.endsWith('·A')).toBe(true);
    });

    it('uses Member at fallbackStep >= 3', () => {
      expect(senderName('Alice', 'A', 'name_suffix', ['LINE'], t, 3)).toBe('Member·A');
      expect(senderName('Alice', 'A', 'none', ['LINE'], t, 3)).toBe('Member');
    });
  });

  describe('translate text', () => {
    it('relays plain text verbatim', () => {
      const origin: OriginForTranslate = {
        messageId: 'm1',
        type: 'text',
        text: 'hello world',
        meta: {},
      };
      const res = translate(origin, baseContext, 'relay');
      expect(res).toHaveLength(1);
      const msg = res[0]!;
      expect(msg.type).toBe('text');
      if (msg.type === 'text') {
        expect(msg.text).toBe('hello world');
        expect(msg.sender?.name).toBe('Alice·A');
        expect(msg.sender?.iconUrl).toBe('https://media.example/alice.png');
      }
    });

    it('replaces @All mention with plain text @All', () => {
      const origin: OriginForTranslate = {
        messageId: 'm1',
        type: 'text',
        text: 'attention @all please',
        meta: {
          mentionees: [{ index: 10, length: 4, type: 'all' }],
        },
      };
      const res = translate(origin, baseContext, 'relay');
      if (res[0]?.type === 'text') {
        expect(res[0].text).toBe('attention @All please');
      }
    });

    it('replaces LINE emoji with $ and offsets indices correctly', () => {
      const origin: OriginForTranslate = {
        messageId: 'm1',
        type: 'text',
        text: 'great (smile) job',
        meta: {
          emojis: [{ index: 6, length: 7, productId: 'p1', emojiId: 'e1' }],
        },
      };
      const res = translate(origin, baseContext, 'relay');
      if (res[0]?.type === 'text') {
        expect(res[0].text).toBe('great $ job');
        expect(res[0].emojis).toEqual([{ index: 6, productId: 'p1', emojiId: 'e1' }]);
        // Character at emoji index is indeed '$'
        expect(res[0].text.charAt(6)).toBe('$');
      }
    });

    it('offsets emoji indices when origin prefix is enabled', () => {
      const ctx: TranslateContext = {
        ...baseContext,
        bridge: { ...baseContext.bridge, originTagStyle: 'text_prefix' },
      };
      const origin: OriginForTranslate = {
        messageId: 'm1',
        type: 'text',
        text: 'hi (smile)',
        meta: {
          emojis: [{ index: 3, length: 7, productId: 'p1', emojiId: 'e1' }],
        },
      };
      const res = translate(origin, ctx, 'relay');
      if (res[0]?.type === 'text') {
        expect(res[0].text.startsWith('[A] ')).toBe(true);
        const idx = res[0].emojis![0]!.index;
        expect(res[0].text.charAt(idx!)).toBe('$');
      }
    });

    it('attaches quoteToken when quoting with valid quote token', () => {
      const ctx: TranslateContext = {
        ...baseContext,
        quote: { quoteToken: 'qt-123', authorName: 'Bob', snippet: 'earlier message' },
      };
      const origin: OriginForTranslate = {
        messageId: 'm1',
        type: 'text',
        text: 'reply text',
        meta: {},
      };
      const res = translate(origin, ctx, 'relay');
      if (res[0]?.type === 'text') {
        expect(res[0].quoteToken).toBe('qt-123');
        expect(res[0].text).toBe('reply text');
      }
    });

    it('prepends fallback line when quoting without quote token', () => {
      const ctx: TranslateContext = {
        ...baseContext,
        quote: { quoteToken: null, authorName: 'Bob', snippet: 'earlier message' },
      };
      const origin: OriginForTranslate = {
        messageId: 'm1',
        type: 'text',
        text: 'reply text',
        meta: {},
      };
      const res = translate(origin, ctx, 'relay');
      if (res[0]?.type === 'text') {
        expect(res[0].quoteToken).toBeUndefined();
        expect(res[0].text).toContain('↩ Bob: earlier message\nreply text');
      }
    });

    it('splits text longer than 5000 units', () => {
      const longText = 'a'.repeat(6000);
      const origin: OriginForTranslate = {
        messageId: 'm1',
        type: 'text',
        text: longText,
        meta: {},
      };
      const res = translate(origin, baseContext, 'relay');
      expect(res.length).toBeGreaterThan(1);
      expect(res.every((m) => m.type === 'text' && m.text.length <= 5000)).toBe(true);
    });

    it('uses textV2 when mentionee is in targetMemberIds', () => {
      const origin: OriginForTranslate = {
        messageId: 'm1',
        type: 'text',
        text: 'hello @Ken how are you',
        meta: {
          mentionees: [{ index: 6, length: 4, type: 'user', userId: 'Uknown' }],
        },
      };
      const res = translate(origin, baseContext, 'relay');
      expect(res[0]?.type).toBe('textV2');
      if (res[0]?.type === 'textV2') {
        expect(res[0].text).toContain('{m_0}');
        expect(res[0].substitution?.m_0).toEqual({
          type: 'mention',
          mentionee: { type: 'user', userId: 'Uknown' },
        });
      }
    });
  });

  describe('translate edits', () => {
    it('translates edit with quoteToken', () => {
      const ctx: TranslateContext = {
        ...baseContext,
        quote: { quoteToken: 'qt-copy', authorName: 'Alice', snippet: 'old text' },
      };
      const origin: OriginForTranslate = {
        messageId: 'm1',
        type: 'text',
        text: 'new edited text',
        meta: {},
      };
      const res = translate(origin, ctx, 'edit');
      expect(res[0]?.type).toBe('text');
      if (res[0]?.type === 'text') {
        expect(res[0].quoteToken).toBe('qt-copy');
        expect(res[0].text).toBe('✏️ (edited)\nnew edited text');
      }
    });

    it('translates edit without quoteToken using author prefix', () => {
      const ctx: TranslateContext = {
        ...baseContext,
        quote: null,
      };
      const origin: OriginForTranslate = {
        messageId: 'm1',
        type: 'text',
        text: 'new edited text',
        meta: {},
      };
      const res = translate(origin, ctx, 'edit');
      if (res[0]?.type === 'text') {
        expect(res[0].text).toContain('✏️ (edited) Alice:\nnew edited text');
      }
    });
  });

  describe('translate stickers', () => {
    it('relays sendable stickers as sticker objects', () => {
      const origin: OriginForTranslate = {
        messageId: 'm1',
        type: 'sticker',
        text: null,
        meta: { sticker: { packageId: '446', stickerId: '1988' } },
      };
      const res = translate(origin, baseContext, 'relay');
      expect(res[0]).toEqual({
        type: 'sticker',
        packageId: '446',
        stickerId: '1988',
        quoteToken: undefined,
        sender: { name: 'Alice·A', iconUrl: 'https://media.example/alice.png' },
      });
    });

    it('falls back to message sticker text if not sendable', () => {
      const origin: OriginForTranslate = {
        messageId: 'm1',
        type: 'sticker',
        text: null,
        meta: { sticker: { packageId: '999', stickerId: '999', text: 'Custom Hello' } },
      };
      const res = translate(origin, baseContext, 'relay');
      expect(res[0]?.type).toBe('text');
      if (res[0]?.type === 'text') {
        expect(res[0].text).toBe('[sticker] "Custom Hello"');
      }
    });

    it('falls back to keywords if present on non-sendable sticker', () => {
      const origin: OriginForTranslate = {
        messageId: 'm1',
        type: 'sticker',
        text: null,
        meta: { sticker: { packageId: '999', stickerId: '999', keywords: ['happy', 'smile', 'joy', 'extra'] } },
      };
      const res = translate(origin, baseContext, 'relay');
      if (res[0]?.type === 'text') {
        expect(res[0].text).toBe('[sticker] (happy, smile, joy)');
      }
    });
  });

  describe('translate media', () => {
    it('relays image when media URLs exist', () => {
      const ctx: TranslateContext = {
        ...baseContext,
        media: { originalUrl: 'https://media.example/orig.jpg', previewUrl: 'https://media.example/prev.jpg' },
      };
      const origin: OriginForTranslate = { messageId: 'm1', type: 'image', text: null, meta: {} };
      const res = translate(origin, ctx, 'relay');
      expect(res[0]).toEqual({
        type: 'image',
        originalContentUrl: 'https://media.example/orig.jpg',
        previewImageUrl: 'https://media.example/prev.jpg',
        sender: { name: 'Alice·A', iconUrl: 'https://media.example/alice.png' },
      });
    });

    it('falls back to photo unavailable when image download failed', () => {
      const ctx: TranslateContext = { ...baseContext, media: { unavailable: true } };
      const origin: OriginForTranslate = { messageId: 'm1', type: 'image', text: null, meta: {} };
      const res = translate(origin, ctx, 'relay');
      expect(res[0]).toEqual({
        type: 'text',
        text: '[photo unavailable]',
        sender: { name: 'Alice·A', iconUrl: 'https://media.example/alice.png' },
      });
    });

    it('relays video with playable URLs', () => {
      const ctx: TranslateContext = {
        ...baseContext,
        media: { originalUrl: 'https://media.example/video.mp4', previewUrl: 'https://media.example/prev.jpg' },
      };
      const origin: OriginForTranslate = { messageId: 'm1', type: 'video', text: null, meta: {} };
      const res = translate(origin, ctx, 'relay');
      expect(res[0]).toEqual({
        type: 'video',
        originalContentUrl: 'https://media.example/video.mp4',
        previewImageUrl: 'https://media.example/prev.jpg',
        sender: { name: 'Alice·A', iconUrl: 'https://media.example/alice.png' },
      });
    });

    it('falls back to video link when playable URL not available but linkUrl is', () => {
      const ctx: TranslateContext = {
        ...baseContext,
        media: { linkUrl: 'https://media.example/download/video.mp4' },
      };
      const origin: OriginForTranslate = { messageId: 'm1', type: 'video', text: null, meta: {} };
      const res = translate(origin, ctx, 'relay');
      expect(res[0]?.type).toBe('text');
      if (res[0]?.type === 'text') {
        expect(res[0].text).toContain('🎬 Alice sent a video: https://media.example/download/video.mp4');
      }
    });

    it('relays audio with duration', () => {
      const ctx: TranslateContext = {
        ...baseContext,
        media: { originalUrl: 'https://media.example/audio.m4a', durationMs: 4500 },
      };
      const origin: OriginForTranslate = { messageId: 'm1', type: 'audio', text: null, meta: {} };
      const res = translate(origin, ctx, 'relay');
      expect(res[0]).toEqual({
        type: 'audio',
        originalContentUrl: 'https://media.example/audio.m4a',
        duration: 4500,
        sender: { name: 'Alice·A', iconUrl: 'https://media.example/alice.png' },
      });
    });

    it('relays file with download link and formatted size', () => {
      const ctx: TranslateContext = {
        ...baseContext,
        media: { linkUrl: 'https://media.example/report.pdf' },
      };
      const origin: OriginForTranslate = {
        messageId: 'm1',
        type: 'file',
        text: null,
        meta: { file: { name: 'report.pdf', size: 1048576 } },
      };
      const res = translate(origin, ctx, 'relay');
      expect(res[0]?.type).toBe('text');
      if (res[0]?.type === 'text') {
        expect(res[0].text).toContain('📎 report.pdf (1.0 MB)\nhttps://media.example/report.pdf');
      }
    });

    it('relays file as not relayed when tooLarge', () => {
      const ctx: TranslateContext = {
        ...baseContext,
        media: { tooLarge: true },
      };
      const origin: OriginForTranslate = {
        messageId: 'm1',
        type: 'file',
        text: null,
        meta: { file: { name: 'huge.zip', size: 100 * 1048576 } },
      };
      const res = translate(origin, ctx, 'relay');
      if (res[0]?.type === 'text') {
        expect(res[0].text).toContain('📎 huge.zip (100.0 MB) — not relayed');
      }
    });

    it('relays location truncated to 100 units', () => {
      const origin: OriginForTranslate = {
        messageId: 'm1',
        type: 'location',
        text: null,
        meta: {
          location: {
            title: 'Station'.repeat(20),
            address: 'Tokyo'.repeat(30),
            latitude: 35.6812,
            longitude: 139.7671,
          },
        },
      };
      const res = translate(origin, baseContext, 'relay');
      expect(res[0]?.type).toBe('location');
      if (res[0]?.type === 'location') {
        expect(res[0].title.length).toBeLessThanOrEqual(100);
        expect(res[0].address.length).toBeLessThanOrEqual(100);
        expect(res[0].latitude).toBe(35.6812);
        expect(res[0].longitude).toBe(139.7671);
      }
    });
  });

  describe('fallback ladder', () => {
    it('step 1 strips emojis and uses plain (name) text', () => {
      const ctx: TranslateContext = { ...baseContext, fallbackStep: 1 };
      const origin: OriginForTranslate = {
        messageId: 'm1',
        type: 'text',
        text: 'hello (smile)',
        meta: { emojis: [{ index: 6, length: 7, productId: 'p1', emojiId: 'e1' }] },
      };
      const res = translate(origin, ctx, 'relay');
      if (res[0]?.type === 'text') {
        expect(res[0].text).toBe('hello (smile)');
        expect(res[0].emojis).toBeUndefined();
      }
    });

    it('step 2 drops quoteToken and falls back to prefix line', () => {
      const ctx: TranslateContext = {
        ...baseContext,
        fallbackStep: 2,
        quote: { quoteToken: 'qt-1', authorName: 'Bob', snippet: 'old text' },
      };
      const origin: OriginForTranslate = { messageId: 'm1', type: 'text', text: 'reply', meta: {} };
      const res = translate(origin, ctx, 'relay');
      if (res[0]?.type === 'text') {
        expect(res[0].quoteToken).toBeUndefined();
        expect(res[0].text).toContain('↩ Bob: old text');
      }
    });

    it('step 3 drops iconUrl and uses Member name', () => {
      const ctx: TranslateContext = { ...baseContext, fallbackStep: 3 };
      const origin: OriginForTranslate = { messageId: 'm1', type: 'text', text: 'hi', meta: {} };
      const res = translate(origin, ctx, 'relay');
      expect(res[0]?.sender?.name).toBe('Member·A');
      expect(res[0]?.sender?.iconUrl).toBeUndefined();
    });

    it('step 4 converts stickers and images to text fallbacks', () => {
      const ctx: TranslateContext = {
        ...baseContext,
        fallbackStep: 4,
        media: { originalUrl: 'https://media.example/img.jpg', previewUrl: 'https://media.example/prev.jpg' },
      };
      const stickerOrigin: OriginForTranslate = {
        messageId: 'm1',
        type: 'sticker',
        text: null,
        meta: { sticker: { packageId: '446', stickerId: '1988' } },
      };
      const imageOrigin: OriginForTranslate = { messageId: 'm2', type: 'image', text: null, meta: {} };
      expect(translate(stickerOrigin, ctx, 'relay')[0]?.type).toBe('text');
      expect(translate(imageOrigin, ctx, 'relay')[0]?.type).toBe('text');
    });
  });

  describe('snippetFor and noticeMessage', () => {
    it('creates snippets for various types', () => {
      expect(snippetFor({ type: 'text', text: 'hello' }, t)).toBe('hello');
      expect(snippetFor({ type: 'image', text: null }, t)).toBe('[photo]');
      expect(snippetFor({ type: 'video', text: null }, t)).toBe('[video]');
      expect(snippetFor({ type: 'file', text: null }, t)).toBe('[file]');
      expect(snippetFor({ type: 'unknown', text: null }, t)).toBe('[message]');
    });

    it('creates notice message with sanitized bridge name and icon', () => {
      const notice = noticeMessage('Group B joined', { name: 'LINE Alumni', iconUrl: 'https://media.example/icon.png' });
      expect(notice.type).toBe('text');
      if (notice.type === 'text') {
        expect(notice.text).toBe('Group B joined');
        expect(notice.sender?.name?.toLowerCase()).not.toContain('line');
        expect(notice.sender?.iconUrl).toBe('https://media.example/icon.png');
      }
    });
  });
});
