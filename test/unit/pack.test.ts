import { describe, expect, it } from 'vitest';
import { translator } from '../../src/i18n/index.js';
import { pack } from '../../src/translate/pack.js';
import type { PackItem, PackOptions } from '../../src/translate/types.js';

const t = translator('en');
const baseOpts: PackOptions = {
  mode: 'preserve',
  digestSender: { name: 'Alumni Bridge', iconUrl: 'https://media.example/bridge.png' },
  t,
};

function textItem(id: string, text: string, authorLabel = 'Ken·B'): PackItem {
  return {
    jobId: `job-${id}`,
    originMessageId: `msg-${id}`,
    authorLabel,
    objects: [{ type: 'text', text, sender: { name: authorLabel } }],
  };
}

function imageItem(id: string, authorLabel = 'Ken·B'): PackItem {
  return {
    jobId: `job-${id}`,
    originMessageId: `msg-${id}`,
    authorLabel,
    objects: [{ type: 'image', originalContentUrl: 'https://media.example/orig.jpg', previewImageUrl: 'https://media.example/prev.jpg' }],
  };
}

describe('pack module', () => {
  it('returns empty result for empty items', () => {
    const res = pack([], baseOpts);
    expect(res.messages).toHaveLength(0);
    expect(res.includedJobIds).toHaveLength(0);
    expect(res.summarizedJobIds).toHaveLength(0);
  });

  describe('preserve mode', () => {
    it('packs up to 5 items whole in order', () => {
      const items = [textItem('1', 'a'), textItem('2', 'b'), textItem('3', 'c')];
      const res = pack(items, { ...baseOpts, mode: 'preserve' });
      expect(res.messages).toHaveLength(3);
      expect(res.includedJobIds).toEqual(['job-1', 'job-2', 'job-3']);
      expect(res.summarizedJobIds).toHaveLength(0);
    });

    it('stops when the next item would exceed 5 objects', () => {
      const items = [
        textItem('1', 'a'),
        textItem('2', 'b'),
        textItem('3', 'c'),
        textItem('4', 'd'),
        textItem('5', 'e'),
        textItem('6', 'f'),
      ];
      const res = pack(items, { ...baseOpts, mode: 'preserve' });
      expect(res.messages).toHaveLength(5);
      expect(res.includedJobIds).toEqual(['job-1', 'job-2', 'job-3', 'job-4', 'job-5']);
      expect(res.summarizedJobIds).toHaveLength(0);
    });

    it('truncates a single item with more than 5 objects to 5', () => {
      const item: PackItem = {
        jobId: 'job-multi',
        originMessageId: 'msg-multi',
        authorLabel: 'Ken·B',
        objects: [
          { type: 'text', text: '1' },
          { type: 'text', text: '2' },
          { type: 'text', text: '3' },
          { type: 'text', text: '4' },
          { type: 'text', text: '5' },
          { type: 'text', text: '6' },
        ],
      };
      const res = pack([item], { ...baseOpts, mode: 'preserve' });
      expect(res.messages).toHaveLength(5);
      expect(res.includedJobIds).toEqual(['job-multi']);
    });
  });

  describe('merge mode (batched)', () => {
    it('does not merge if total objects <= 5', () => {
      const items = [textItem('1', 'a', 'Ken·B'), textItem('2', 'b', 'Yuki·C')];
      const res = pack(items, { ...baseOpts, mode: 'merge' });
      expect(res.messages).toHaveLength(2);
      expect(res.messages[0]?.sender?.name).toBe('Ken·B');
      expect(res.messages[1]?.sender?.name).toBe('Yuki·C');
    });

    it('merges consecutive text objects when total objects > 5', () => {
      const items = [
        textItem('1', 'msg1', 'Ken·B'),
        textItem('2', 'msg2', 'Yuki·C'),
        textItem('3', 'msg3', 'Ken·B'),
        textItem('4', 'msg4', 'Aiko·A'),
        textItem('5', 'msg5', 'Ken·B'),
        textItem('6', 'msg6', 'Yuki·C'),
      ];
      const res = pack(items, { ...baseOpts, mode: 'merge' });
      expect(res.messages.length).toBeLessThanOrEqual(5);
      expect(res.includedJobIds).toHaveLength(6);
      expect(res.summarizedJobIds).toHaveLength(0);
      const first = res.messages[0]!;
      expect(first.type).toBe('text');
      if (first.type === 'text') {
        expect(first.text).toContain('Ken·B: msg1');
        expect(first.text).toContain('Yuki·C: msg2');
        expect(first.sender?.name).toBe('Alumni Bridge');
      }
    });

    it('keeps media objects distinct and merges surrounding texts', () => {
      const items = [
        textItem('1', 'before', 'Ken·B'),
        imageItem('2', 'Ken·B'),
        textItem('3', 'after1', 'Yuki·C'),
        textItem('4', 'after2', 'Aiko·A'),
        textItem('5', 'after3', 'Ken·B'),
        textItem('6', 'after4', 'Yuki·C'),
      ];
      const res = pack(items, { ...baseOpts, mode: 'merge' });
      expect(res.messages.length).toBeLessThanOrEqual(5);
      expect(res.messages.some((m) => m.type === 'image')).toBe(true);
    });
  });

  describe('digest mode (economy)', () => {
    it('consumes all items and produces trailing summary if overflow', () => {
      const items = [
        imageItem('1', 'Ken·B'),
        imageItem('2', 'Ken·B'),
        imageItem('3', 'Ken·B'),
        imageItem('4', 'Ken·B'),
        imageItem('5', 'Ken·B'),
        imageItem('6', 'Ken·B'),
        imageItem('7', 'Ken·B'),
      ];
      const res = pack(items, { ...baseOpts, mode: 'digest' });
      expect(res.messages.length).toBeLessThanOrEqual(5);
      // The last message is the summary
      const last = res.messages[res.messages.length - 1]!;
      expect(last.type).toBe('text');
      if (last.type === 'text') {
        expect(last.text).toMatch(/…and \d+ more messages/);
      }
      expect(res.summarizedJobIds.length).toBeGreaterThan(0);
      expect(res.includedJobIds.length + res.summarizedJobIds.length).toBe(items.length);
    });
  });
});
