import type { Translate } from '../i18n/index.js';
import type { Emoji, Mentionee, OutboundMessage, Sender } from '../line/types.js';
import { cleanSingleLine, fit, splitText } from '../util/utf16.js';
import type { OriginForTranslate, OriginTagStyle, TranslateContext } from './types.js';

const MAX_TEXT_LENGTH = 5000;
const MAX_EMOJIS = 20;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Sanitizes names containing forbidden words (e.g. 'LINE' -> 'L1NE') case-insensitively ([09] §1). */
export function sanitizeForbidden(s: string, forbiddenWords: string[]): string {
  let out = s;
  for (const word of forbiddenWords) {
    if (!word) continue;
    const re = new RegExp(escapeRegex(word), 'gi');
    out = out.replace(re, (m) => m.replace(/i/gi, '1'));
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Derives `sender.name` (<= 20 UTF-16 units, grapheme-safe, never cuts surrogates,
 * forbidden words sanitized, clean single-line).
 */
export function senderName(
  displayName: string | null,
  shortTag: string,
  style: OriginTagStyle,
  forbiddenWords: string[],
  t: Translate,
  fallbackStep = 0,
): string {
  if (fallbackStep >= 3) {
    const base = t('member');
    if (style === 'name_suffix' && shortTag) {
      const suffix = `·${shortTag}`;
      return fit(base, 20 - suffix.length) + suffix;
    }
    return fit(base, 20);
  }

  const baseRaw = displayName ? cleanSingleLine(displayName) : '';
  const base = baseRaw.trim() ? baseRaw : t('line_user');

  let name: string;
  if (style === 'name_suffix' && shortTag) {
    const suffix = `·${shortTag}`;
    const budget = Math.max(1, 20 - suffix.length);
    name = fit(base, budget) + suffix;
  } else {
    name = fit(base, 20);
  }

  name = sanitizeForbidden(name, forbiddenWords);
  if (name.length > 20) name = fit(name, 20);
  return name.trim() || t('member');
}

export function snippetFor(origin: { type: string; text: string | null }, t: Translate): string {
  if (origin.text && origin.text.trim()) {
    return fit(cleanSingleLine(origin.text), 50);
  }
  switch (origin.type) {
    case 'image':
      return t('snippet_photo');
    case 'video':
      return t('snippet_video');
    case 'audio':
      return t('snippet_audio');
    case 'file':
      return t('snippet_file');
    case 'location':
      return t('snippet_location');
    case 'sticker':
      return t('snippet_sticker');
    default:
      return t('snippet_message');
  }
}

export function noticeMessage(text: string, bridge: { name: string; iconUrl: string }): OutboundMessage {
  const name = senderName(bridge.name, '', 'none', ['LINE'], (k) => k);
  return {
    type: 'text',
    text: fit(text, MAX_TEXT_LENGTH),
    sender: { name, iconUrl: bridge.iconUrl },
  };
}

/**
 * Pure translation function: transforms an origin message into outbound LINE message objects
 * per the translation spec (FR-ATT, FR-MSG, FR-EVT-2/3, [09]).
 */
export function translate(origin: OriginForTranslate, ctx: TranslateContext, kind: 'relay' | 'edit'): OutboundMessage[] {
  const sender: Sender = {
    name: senderName(ctx.author.displayName, ctx.originGroup.shortTag, ctx.bridge.originTagStyle, ctx.forbiddenWords, ctx.t, ctx.fallbackStep),
    iconUrl: ctx.fallbackStep >= 3 ? undefined : (ctx.author.iconUrl ?? ctx.bridge.iconUrl),
  };

  if (kind === 'edit') {
    return translateEdit(origin, ctx, sender);
  }

  switch (origin.type) {
    case 'text':
      return translateText(origin, ctx, sender);
    case 'sticker':
      return translateSticker(origin, ctx, sender);
    case 'image':
      return translateImage(origin, ctx, sender);
    case 'video':
      return translateVideo(origin, ctx, sender);
    case 'audio':
      return translateAudio(origin, ctx, sender);
    case 'file':
      return translateFile(origin, ctx, sender);
    case 'location':
      return translateLocation(origin, ctx, sender);
    default:
      return [{ type: 'text', text: ctx.t('snippet_message'), sender }];
  }
}

function translateEdit(origin: OriginForTranslate, ctx: TranslateContext, sender: Sender): OutboundMessage[] {
  const newText = origin.text ?? '';
  const quoteToken = ctx.quote?.quoteToken && ctx.fallbackStep < 2 ? ctx.quote.quoteToken : undefined;

  let body: string;
  if (quoteToken) {
    body = `✏️ ${ctx.t('edited')}\n${newText}`;
  } else {
    const author = ctx.quote?.authorName ?? ctx.author.displayName ?? ctx.t('line_user');
    body = `${ctx.t('edited_prefix', { author })}\n${newText}`;
  }

  const parts = splitText(body, MAX_TEXT_LENGTH);
  return parts.slice(0, 5).map((part, i) => {
    const isLast = i === Math.min(parts.length - 1, 4);
    const text = isLast && parts.length > 5 ? fit(part, MAX_TEXT_LENGTH - 1) + '…' : part;
    const msg: OutboundMessage = {
      type: 'text',
      text,
      sender,
      quoteToken: i === 0 && quoteToken ? quoteToken : undefined,
    };
    return msg;
  });
}

function translateText(origin: OriginForTranslate, ctx: TranslateContext, sender: Sender): OutboundMessage[] {
  const rawText = origin.text ?? '';
  const mentionees = (origin.meta.mentionees ?? []).slice().sort((a, b) => b.index - a.index);
  const emojis = (origin.meta.emojis ?? []).slice().sort((a, b) => b.index - a.index);

  // Check if we should use textV2 for co-member mentions
  const coMembers = mentionees.filter((m) => m.type === 'user' && m.userId && ctx.targetMemberIds.has(m.userId));
  const useTextV2 = coMembers.length > 0 && ctx.fallbackStep < 1;

  if (useTextV2) {
    return translateTextV2(rawText, mentionees, emojis, ctx, sender);
  }

  return translatePlainText(rawText, mentionees, emojis, ctx, sender);
}

function translatePlainText(
  rawText: string,
  mentionees: Mentionee[],
  emojis: Emoji[],
  ctx: TranslateContext,
  sender: Sender,
): OutboundMessage[] {
  // Step 1: Mentions right-to-left: replace @All with plain '@All', leave others as typed
  let text = rawText;
  for (const m of mentionees) {
    if (m.type === 'all') {
      text = text.slice(0, m.index) + '@All' + text.slice(m.index + m.length);
    }
  }

  // Step 2: LINE emojis -> replace span with $ (unless fallbackStep >= 1)
  const outboundEmojis: Array<{ index: number; productId: string; emojiId: string }> = [];
  if (ctx.fallbackStep < 1 && emojis.length > 0) {
    // Re-verify emoji spans on the original text
    for (const e of emojis.slice(0, MAX_EMOJIS)) {
      if (e.index >= 0 && e.index + e.length <= text.length) {
        text = text.slice(0, e.index) + '$' + text.slice(e.index + e.length);
        outboundEmojis.unshift({ index: e.index, productId: e.productId, emojiId: e.emojiId });
      }
    }
  }

  // Step 3: Origin prefix [shortTag]
  let prefix = '';
  if (ctx.bridge.originTagStyle === 'text_prefix' && ctx.originGroup.shortTag) {
    prefix += `[${ctx.originGroup.shortTag}] `;
  }

  // Step 4: Quotes
  const quoteToken = ctx.quote?.quoteToken && ctx.fallbackStep < 2 ? ctx.quote.quoteToken : undefined;
  if (!quoteToken && ctx.quote) {
    prefix = `${ctx.t('replying_to', { author: ctx.quote.authorName, snippet: fit(ctx.quote.snippet, 50) })}\n` + prefix;
  }

  text = prefix + text;
  const prefixLength = prefix.length;

  // Shift emoji indices by prefixLength
  for (const e of outboundEmojis) {
    e.index += prefixLength;
  }

  // Split into chunks if > 5000 units
  const parts = splitText(text, MAX_TEXT_LENGTH);
  return parts.slice(0, 5).map((part, i) => {
    const isLast = i === Math.min(parts.length - 1, 4);
    const chunkText = isLast && parts.length > 5 ? fit(part, MAX_TEXT_LENGTH - 1) + '…' : part;

    // Only first chunk gets quoteToken and relevant emojis
    const chunkEmojis = i === 0 && outboundEmojis.length > 0 ? outboundEmojis.filter((e) => e.index < chunkText.length) : undefined;

    const msg: OutboundMessage = {
      type: 'text',
      text: chunkText,
      sender,
      quoteToken: i === 0 && quoteToken ? quoteToken : undefined,
      emojis: chunkEmojis && chunkEmojis.length > 0 ? chunkEmojis : undefined,
    };
    return msg;
  });
}

function translateTextV2(
  rawText: string,
  mentionees: Mentionee[],
  emojis: Emoji[],
  ctx: TranslateContext,
  sender: Sender,
): OutboundMessage[] {
  let text = rawText;
  const substitution: Record<string, { type: 'mention'; mentionee: { type: 'user'; userId: string } } | { type: 'emoji'; productId: string; emojiId: string }> = {};

  let mCount = 0;
  for (const m of mentionees) {
    if (m.type === 'all') {
      text = text.slice(0, m.index) + '@All' + text.slice(m.index + m.length);
    } else if (m.type === 'user' && m.userId && ctx.targetMemberIds.has(m.userId)) {
      const key = `m_${mCount++}`;
      text = text.slice(0, m.index) + `{${key}}` + text.slice(m.index + m.length);
      substitution[key] = { type: 'mention', mentionee: { type: 'user', userId: m.userId } };
    }
  }

  let eCount = 0;
  for (const e of emojis) {
    if (e.index >= 0 && e.index + e.length <= text.length && eCount < MAX_EMOJIS) {
      const key = `e_${eCount++}`;
      text = text.slice(0, e.index) + `{${key}}` + text.slice(e.index + e.length);
      substitution[key] = { type: 'emoji', productId: e.productId, emojiId: e.emojiId };
    }
  }

  let prefix = '';
  if (ctx.bridge.originTagStyle === 'text_prefix' && ctx.originGroup.shortTag) {
    prefix += `[${ctx.originGroup.shortTag}] `;
  }
  const quoteToken = ctx.quote?.quoteToken && ctx.fallbackStep < 2 ? ctx.quote.quoteToken : undefined;
  if (!quoteToken && ctx.quote) {
    prefix = `${ctx.t('replying_to', { author: ctx.quote.authorName, snippet: fit(ctx.quote.snippet, 50) })}\n` + prefix;
  }
  text = prefix + text;

  const parts = splitText(text, MAX_TEXT_LENGTH);
  return parts.slice(0, 5).map((part, i) => {
    const isLast = i === Math.min(parts.length - 1, 4);
    const chunkText = isLast && parts.length > 5 ? fit(part, MAX_TEXT_LENGTH - 1) + '…' : part;
    if (i === 0) {
      return {
        type: 'textV2',
        text: chunkText,
        substitution: Object.keys(substitution).length > 0 ? substitution : undefined,
        quoteToken,
        sender,
      };
    }
    return {
      type: 'text',
      text: chunkText,
      sender,
    };
  });
}

function translateSticker(origin: OriginForTranslate, ctx: TranslateContext, sender: Sender): OutboundMessage[] {
  const meta = origin.meta.sticker;
  const packageId = meta?.packageId ?? '';
  const stickerId = meta?.stickerId ?? '';

  const sendable = ctx.isStickerSendable(packageId, stickerId);
  if (sendable && ctx.fallbackStep < 4) {
    const quoteToken = ctx.quote?.quoteToken && ctx.fallbackStep < 2 ? ctx.quote.quoteToken : undefined;
    return [
      {
        type: 'sticker',
        packageId,
        stickerId,
        quoteToken,
        sender,
      },
    ];
  }

  // Fallback text
  let fallbackText = ctx.t('sticker');
  if (meta?.text) {
    fallbackText = `${ctx.t('sticker')} "${meta.text}"`;
  } else if (meta?.keywords && meta.keywords.length > 0) {
    fallbackText = `${ctx.t('sticker')} (${meta.keywords.slice(0, 3).join(', ')})`;
  }

  if (ctx.quote) {
    fallbackText = `${ctx.t('replying_to', { author: ctx.quote.authorName, snippet: fit(ctx.quote.snippet, 50) })}\n${fallbackText}`;
  }

  return [{ type: 'text', text: fit(fallbackText, MAX_TEXT_LENGTH), sender }];
}

function translateImage(origin: OriginForTranslate, ctx: TranslateContext, sender: Sender): OutboundMessage[] {
  if (ctx.media?.unavailable || ctx.fallbackStep >= 4) {
    return [{ type: 'text', text: ctx.t('photo_unavailable'), sender }];
  }
  if (ctx.media?.originalUrl && ctx.media?.previewUrl) {
    return [
      {
        type: 'image',
        originalContentUrl: ctx.media.originalUrl,
        previewImageUrl: ctx.media.previewUrl,
        sender,
      },
    ];
  }
  return [{ type: 'text', text: ctx.t('photo_unavailable'), sender }];
}

function translateVideo(origin: OriginForTranslate, ctx: TranslateContext, sender: Sender): OutboundMessage[] {
  if (ctx.media?.unavailable) {
    return [{ type: 'text', text: ctx.t('video_unavailable'), sender }];
  }
  if (ctx.media?.originalUrl && ctx.media?.previewUrl && ctx.fallbackStep < 4) {
    return [
      {
        type: 'video',
        originalContentUrl: ctx.media.originalUrl,
        previewImageUrl: ctx.media.previewUrl,
        sender,
      },
    ];
  }
  if (ctx.media?.linkUrl) {
    const author = ctx.author.displayName ?? ctx.t('line_user');
    return [{ type: 'text', text: ctx.t('video_link', { author, url: ctx.media.linkUrl }), sender }];
  }
  return [{ type: 'text', text: ctx.t('video_unavailable'), sender }];
}

function translateAudio(origin: OriginForTranslate, ctx: TranslateContext, sender: Sender): OutboundMessage[] {
  if (ctx.media?.unavailable) {
    return [{ type: 'text', text: ctx.t('audio_unavailable'), sender }];
  }
  if (ctx.media?.originalUrl && ctx.media?.durationMs !== undefined && ctx.fallbackStep < 4) {
    return [
      {
        type: 'audio',
        originalContentUrl: ctx.media.originalUrl,
        duration: Math.max(1, Math.round(ctx.media.durationMs)),
        sender,
      },
    ];
  }
  if (ctx.media?.linkUrl) {
    const author = ctx.author.displayName ?? ctx.t('line_user');
    return [{ type: 'text', text: ctx.t('audio_link', { author, url: ctx.media.linkUrl }), sender }];
  }
  return [{ type: 'text', text: ctx.t('audio_unavailable'), sender }];
}

function translateFile(origin: OriginForTranslate, ctx: TranslateContext, sender: Sender): OutboundMessage[] {
  const fileName = origin.meta.file?.name ?? ctx.t('snippet_file');
  const size = origin.meta.file?.size !== undefined ? formatBytes(origin.meta.file.size) : '';
  if (ctx.media?.tooLarge) {
    return [{ type: 'text', text: ctx.t('file_not_relayed', { name: fileName, size }), sender }];
  }
  if (ctx.media?.linkUrl) {
    return [{ type: 'text', text: ctx.t('file_link', { name: fileName, size, url: ctx.media.linkUrl }), sender }];
  }
  return [{ type: 'text', text: ctx.t('snippet_file'), sender }];
}

function translateLocation(origin: OriginForTranslate, ctx: TranslateContext, sender: Sender): OutboundMessage[] {
  const loc = origin.meta.location;
  const title = fit(cleanSingleLine(loc?.title ?? ctx.t('location')), 100);
  const address = fit(cleanSingleLine(loc?.address ?? ''), 100);
  return [
    {
      type: 'location',
      title: title || ctx.t('location'),
      address: address || '',
      latitude: loc?.latitude ?? 0,
      longitude: loc?.longitude ?? 0,
      sender,
    },
  ];
}
