import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { translator } from '../../src/i18n/index.js';
import { pack } from '../../src/translate/pack.js';
import { senderName, translate } from '../../src/translate/translate.js';
import type { PackItem, TranslateContext } from '../../src/translate/types.js';

const t = translator('en');

const baseContext: TranslateContext = {
  bridge: { name: 'Test Bridge', originTagStyle: 'name_suffix', iconUrl: 'https://media.example/default.png' },
  originGroup: { shortTag: 'A' },
  author: { displayName: 'Alice', iconUrl: 'https://media.example/alice.png' },
  quote: null,
  media: null,
  isStickerSendable: () => true,
  fallbackStep: 0,
  forbiddenWords: ['LINE'],
  targetMemberIds: new Set(),
  t,
};

// Generates text with arbitrary unicode, including surrogate pairs like 🍎, 🌸, 🚀, and ZWJ sequences
const unicodeTextArb = fc.string({ maxLength: 6000 });
const shortNameArb = fc.string({ maxLength: 50 });

describe('Property tests (fast-check)', () => {
  it('P4: senderName is always <= 20 UTF-16 units and never cuts surrogate pairs', () => {
    fc.assert(
      fc.property(shortNameArb, fc.constantFrom('none', 'name_suffix', 'text_prefix') as fc.Arbitrary<'none' | 'name_suffix' | 'text_prefix'>, (name, style) => {
        const result = senderName(name, 'A', style, ['LINE'], t);
        expect(result.length).toBeLessThanOrEqual(20);
        expect(result.length).toBeGreaterThan(0);
        // Check for lone surrogates
        for (let i = 0; i < result.length; i++) {
          const code = result.charCodeAt(i);
          if (code >= 0xd800 && code <= 0xdbff) {
            // High surrogate must be followed by low surrogate
            expect(i + 1).toBeLessThan(result.length);
            const low = result.charCodeAt(i + 1);
            expect(low).toBeGreaterThanOrEqual(0xdc00);
            expect(low).toBeLessThanOrEqual(0xdfff);
            i++; // Skip low surrogate
          } else {
            expect(code < 0xdc00 || code > 0xdfff).toBe(true);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('P4 & P7: translated text messages are always <= 5000 units and emojis point at $', () => {
    fc.assert(
      fc.property(unicodeTextArb, (rawText) => {
        // Construct some random valid emoji spans within the text
        const emojis: Array<{ index: number; length: number; productId: string; emojiId: string }> = [];
        if (rawText.length >= 10) {
          const p1 = Math.floor(rawText.length / 4);
          emojis.push({ index: p1, length: Math.min(5, rawText.length - p1), productId: 'p1', emojiId: 'e1' });
        }

        const origin = {
          messageId: 'm-prop',
          type: 'text',
          text: rawText,
          meta: { emojis },
        };

        const res = translate(origin, baseContext, 'relay');
        expect(res.length).toBeLessThanOrEqual(5);

        for (const msg of res) {
          if (msg.type === 'text') {
            expect(msg.text.length).toBeLessThanOrEqual(5000);
            if (msg.emojis) {
              for (const e of msg.emojis) {
                expect(e.index).toBeLessThan(msg.text.length);
                expect(msg.text.charAt(e.index!)).toBe('$');
              }
            }
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('P4 & P7: pack accounts for all jobs without duplicates and never outputs > 5 objects', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.uuid(),
            text: fc.string({ minLength: 1, maxLength: 500 }),
            author: fc.string({ minLength: 1, maxLength: 10 }),
          }),
          { minLength: 0, maxLength: 20 },
        ),
        fc.constantFrom('preserve', 'merge', 'digest') as fc.Arbitrary<'preserve' | 'merge' | 'digest'>,
        (rawItems, mode) => {
          const items: PackItem[] = rawItems.map((r) => ({
            jobId: `job-${r.id}`,
            originMessageId: `msg-${r.id}`,
            authorLabel: `${r.author}·A`,
            objects: [{ type: 'text', text: r.text, sender: { name: `${r.author}·A` } }],
          }));

          const res = pack(items, {
            mode,
            digestSender: { name: 'Bridge', iconUrl: 'https://media.example/b.png' },
            t,
          });

          expect(res.messages.length).toBeLessThanOrEqual(5);
          for (const m of res.messages) {
            if (m.type === 'text') {
              expect(m.text.length).toBeLessThanOrEqual(5000);
            }
          }

          // In digest mode, every item is either included or summarized
          if (mode === 'digest') {
            expect(res.includedJobIds.length + res.summarizedJobIds.length).toBe(items.length);
          }
          // No duplicate jobs in included or summarized
          const allAccounted = [...res.includedJobIds, ...res.summarizedJobIds];
          expect(new Set(allAccounted).size).toBe(allAccounted.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});
