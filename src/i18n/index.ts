import type { Locale } from '../config.js';
import { en, type Catalog, type MessageKey } from './en.js';
import { ja } from './ja.js';
import { th } from './th.js';
import { zhTw } from './zh-TW.js';

export type { MessageKey };

// Locales registered per NFR-I18N-1 (en, ja, th, zh-TW); missing keys fall back to English.
const catalogs: Record<Locale, Catalog> = {
  en,
  ja,
  th,
  'zh-TW': zhTw,
};

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function t(locale: Locale | string, key: MessageKey, vars: Record<string, string | number> = {}): string {
  const template = catalogs[locale as Locale]?.[key] ?? en[key];
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

export function translator(locale: Locale | string): Translate {
  return (key, vars) => t(locale, key, vars);
}
