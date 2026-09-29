import type { InboundMessage, Mentionee } from '../line/types.js';

export const COMMAND_WORDS = [
  'help',
  'status',
  'create',
  'code',
  'join',
  'leave',
  'kick',
  'rename',
  'tag',
  'mode',
  'window',
  'hold',
  'pause',
  'resume',
  'mute',
  'unmute',
  'admin',
  'mod',
  'silent',
  'optout',
  'optin',
  'notices',
  'locale',
  'budget',
  'style',
] as const;
export type CommandWord = (typeof COMMAND_WORDS)[number];

export interface ParsedCommand {
  /** Known command word, or null for an unknown word after the prefix (answered with help). */
  name: CommandWord | null;
  args: string[];
  /** Text after the command word (for names containing spaces). */
  rest: string;
  /** Users mentioned in the command (excluding the bot), in text order. */
  mentioned: Mentionee[];
}

/**
 * A group text is a command when it starts with the prefix (case-insensitive) or with a mention of
 * the bot at index 0 followed by a known command word (FR-CMD-1, [10] §1).
 */
export function parseCommand(msg: InboundMessage, prefix: string): ParsedCommand | null {
  if (msg.type !== 'text' || typeof msg.text !== 'string') return null;
  const text = msg.text;
  const mentionees = msg.mention?.mentionees ?? [];
  const mentioned = mentionees.filter((m) => m.type === 'user' && !m.isSelf).sort((a, b) => a.index - b.index);

  let body: string;
  let viaMention = false;
  const trimmed = text.trimStart();
  const lead = text.length - trimmed.length;
  if (trimmed.toLowerCase().startsWith(prefix.toLowerCase()) && /^(\s|$)/.test(trimmed.slice(prefix.length))) {
    body = trimmed.slice(prefix.length);
  } else {
    const self = mentionees.find((m) => m.isSelf && m.index === lead);
    if (!self) return null;
    body = text.slice(self.index + self.length);
    viaMention = true;
  }

  body = body.trim();
  const [first = '', ...restWords] = body.split(/\s+/).filter(Boolean);
  const word = first.toLowerCase();
  const known = (COMMAND_WORDS as readonly string[]).includes(word) ? (word as CommandWord) : null;
  // A plain mention of the bot followed by chat is not a command.
  if (viaMention && !known) return null;
  if (!first) return { name: 'help', args: [], rest: '', mentioned };
  return { name: known, args: restWords, rest: body.slice(first.length).trim(), mentioned };
}
