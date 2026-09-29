import type { Locale } from '../config.js';
import { en, type Catalog, type MessageKey } from './en.js';

export type { MessageKey };

// Locales are registered here; missing ones fall back to English.
const catalogs: Partial<Record<Locale, Catalog>> = { en };

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function t(locale: Locale | string, key: MessageKey, vars: Record<string, string | number> = {}): string {
  const template = catalogs[locale as Locale]?.[key] ?? en[key];
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

export function translator(locale: Locale | string): Translate {
  return (key, vars) => t(locale, key, vars);
}
