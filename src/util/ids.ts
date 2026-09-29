import { randomBytes, randomInt, randomUUID } from 'node:crypto';

// Crockford-like alphabet without 0/O/1/I/L/U to avoid misreads when codes are typed by hand.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 8-character link code formatted as XXXX-XXXX (hyphen optional on input). */
export function newLinkCode(): string {
  let raw = '';
  for (let i = 0; i < 8; i++) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Normalizes user-typed codes: uppercase, strip spaces/hyphens, reinsert the hyphen. */
export function normalizeLinkCode(input: string): string | null {
  const raw = input.toUpperCase().replace(/[\s-]/g, '');
  if (raw.length !== 8 || [...raw].some((c) => !CODE_ALPHABET.includes(c))) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** ≥128-bit unguessable URL path token. */
export function randomToken(): string {
  return randomBytes(16).toString('base64url');
}

export const uuid = randomUUID;
