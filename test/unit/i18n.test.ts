import { describe, expect, it } from 'vitest';
import { LOCALES } from '../../src/config.js';
import { en } from '../../src/i18n/en.js';
import { t } from '../../src/i18n/index.js';
import { ja } from '../../src/i18n/ja.js';
import { th } from '../../src/i18n/th.js';
import { zhTw } from '../../src/i18n/zh-TW.js';

describe('i18n catalogs (NFR-I18N-1)', () => {
  const catalogs = { en, ja, th, 'zh-TW': zhTw };
  const keys = Object.keys(en) as Array<keyof typeof en>;

  it('all 4 supported locales have every translation key', () => {
    for (const locale of LOCALES) {
      const cat = catalogs[locale];
      expect(cat).toBeDefined();
      for (const k of keys) {
        expect(cat[k], `missing key "${k}" in locale "${locale}"`).toBeDefined();
        expect(typeof cat[k]).toBe('string');
        expect(cat[k].length).toBeGreaterThan(0);
      }
    }
  });

  it('substitutes {var} template placeholders correctly in all languages', () => {
    for (const locale of LOCALES) {
      const rendered = t(locale, 'replying_to', { author: 'Alice', snippet: 'hello' });
      expect(rendered).toContain('Alice');
      expect(rendered).toContain('hello');
    }
  });

  it('falls back to English when an unsupported locale is requested', () => {
    const rendered = t('fr', 'line_user');
    expect(rendered).toBe('LINE user');
  });
});
