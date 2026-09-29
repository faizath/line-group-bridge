import { describe, expect, it } from 'vitest';
import { cleanSingleLine, fit, splitText } from '../../src/util/utf16.js';

describe('UTF-16 utility functions', () => {
  describe('cleanSingleLine', () => {
    it('collapses multiple whitespace characters and trims', () => {
      expect(cleanSingleLine('  hello \t \n world  ')).toBe('hello world');
    });

    it('removes control characters', () => {
      expect(cleanSingleLine('hello\u0000\u0007\u001fworld')).toBe('hello world');
    });
  });

  describe('fit', () => {
    it('returns empty string for max <= 0', () => {
      expect(fit('hello', 0)).toBe('');
      expect(fit('hello', -1)).toBe('');
    });

    it('returns original string if within limit', () => {
      expect(fit('hello', 10)).toBe('hello');
      expect(fit('hello', 5)).toBe('hello');
    });

    it('truncates with ellipsis', () => {
      expect(fit('abcdefgh', 5)).toBe('abcd…');
      expect(fit('abcdefgh', 5).length).toBe(5);
    });

    it('never cuts surrogate pairs or grapheme clusters', () => {
      // 🍎 has length 2 in UTF-16
      expect(fit('🍎🍎🍎', 5)).toBe('🍎🍎…'); // 🍎 (2) + 🍎 (2) + … (1) = 5
      expect(fit('🍎🍎🍎', 4)).toBe('🍎…'); // budget is 3 -> 1 apple + … = 3
    });

    it('handles ZWJ emoji sequences safely', () => {
      // Family emoji 👨‍👩‍👧‍👦 is a multi-grapheme or ZWJ cluster
      const family = '👨‍👩‍👧‍👦';
      const fitted = fit(family + ' extra text', 10);
      expect(fitted.length).toBeLessThanOrEqual(10);
    });
  });

  describe('splitText', () => {
    it('returns single element if within limit', () => {
      expect(splitText('hello world', 20)).toEqual(['hello world']);
    });

    it('splits on newlines when possible', () => {
      const text = 'line one\nline two\nline three';
      const parts = splitText(text, 15);
      expect(parts.length).toBeGreaterThan(1);
      expect(parts.every((p) => p.length <= 15)).toBe(true);
    });

    it('splits on spaces when no convenient newline', () => {
      const text = 'this is a long text that needs splitting across spaces';
      const parts = splitText(text, 20);
      expect(parts.every((p) => p.length <= 20)).toBe(true);
      expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(text);
    });

    it('splits hard without cutting graphemes when no spaces exist', () => {
      const text = 'abcdefghijklmnopqrstuvwxyz';
      const parts = splitText(text, 10);
      expect(parts).toEqual(['abcdefghij', 'klmnopqrst', 'uvwxyz']);
    });
  });
});
