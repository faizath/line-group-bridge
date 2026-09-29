import type { OutboundMessage } from '../line/types.js';
import { fit } from '../util/utf16.js';
import type { PackedPart, PackItem, PackOptions, PackResult } from './types.js';

const MAX_OBJECTS_DEFAULT = 5;
const MAX_DIGEST_TEXT = 5000;

export function pack(items: PackItem[], opts: PackOptions): PackResult {
  const maxObjects = opts.maxObjects ?? MAX_OBJECTS_DEFAULT;
  if (items.length === 0) {
    return { messages: [], parts: [], includedJobIds: [], summarizedJobIds: [] };
  }

  if (opts.mode === 'preserve') {
    return packPreserve(items, maxObjects);
  }

  if (opts.mode === 'merge') {
    return packMerge(items, maxObjects, opts);
  }

  return packDigest(items, maxObjects, opts);
}

function packPreserve(items: PackItem[], maxObjects: number): PackResult {
  const messages: OutboundMessage[] = [];
  const parts: PackedPart[] = [];
  const includedJobIds: string[] = [];

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx]!;
    // If first item has more than maxObjects, truncate it to maxObjects
    if (idx === 0 && item.objects.length > maxObjects) {
      for (let i = 0; i < maxObjects; i++) {
        messages.push(item.objects[i]!);
        parts.push({
          jobIds: [item.jobId],
          originMessageIds: item.originMessageId ? [item.originMessageId] : [],
          partIndex: i,
        });
      }
      includedJobIds.push(item.jobId);
      break;
    }

    if (messages.length + item.objects.length > maxObjects) {
      break;
    }

    for (let i = 0; i < item.objects.length; i++) {
      messages.push(item.objects[i]!);
      parts.push({
        jobIds: [item.jobId],
        originMessageIds: item.originMessageId ? [item.originMessageId] : [],
        partIndex: i,
      });
    }
    includedJobIds.push(item.jobId);
  }

  return { messages, parts, includedJobIds, summarizedJobIds: [] };
}

function packMerge(items: PackItem[], maxObjects: number, opts: PackOptions): PackResult {
  // If all items fit as-is, preserve their distinct attribution
  const totalRawObjects = items.reduce((s, it) => s + it.objects.length, 0);
  if (totalRawObjects <= maxObjects) {
    return packPreserve(items, maxObjects);
  }

  const messages: OutboundMessage[] = [];
  const parts: PackedPart[] = [];
  const includedJobIds: string[] = [];

  let i = 0;
  while (i < items.length && messages.length < maxObjects) {
    const item = items[i]!;

    // Check if this item is a single text object that can be merged with subsequent text objects
    if (isSingleTextMessage(item)) {
      const remainingSlots = maxObjects - messages.length;
      // If we only have 1 slot left and multiple texts, or multiple texts ahead, merge texts
      const merged = mergeConsecutiveTexts(items, i, remainingSlots, opts);
      messages.push(merged.message);
      parts.push(merged.part);
      includedJobIds.push(...merged.jobIds);
      i += merged.itemCount;
    } else {
      // Non-text or multi-object: add intact if it fits
      if (messages.length + item.objects.length > maxObjects) {
        break;
      }
      for (let p = 0; p < item.objects.length; p++) {
        messages.push(item.objects[p]!);
        parts.push({
          jobIds: [item.jobId],
          originMessageIds: item.originMessageId ? [item.originMessageId] : [],
          partIndex: p,
        });
      }
      includedJobIds.push(item.jobId);
      i++;
    }
  }

  return { messages, parts, includedJobIds, summarizedJobIds: [] };
}

function packDigest(items: PackItem[], maxObjects: number, opts: PackOptions): PackResult {
  // Economy mode: merge texts and collapse overflow into summaries so all items are consumed
  const messages: OutboundMessage[] = [];
  const parts: PackedPart[] = [];
  const includedJobIds: string[] = [];
  const summarizedJobIds: string[] = [];

  let i = 0;
  while (i < items.length) {
    // If we've reached maxObjects - 1 and there are still items left, reserve the last slot for summary
    const itemsRemaining = items.length - i;
    const slotsRemaining = maxObjects - messages.length;

    if (slotsRemaining === 1 && itemsRemaining > 1) {
      // Create trailing "...and N more messages" summary
      const remainingJobs = items.slice(i).map((it) => it.jobId);
      summarizedJobIds.push(...remainingJobs);
      messages.push({
        type: 'text',
        text: opts.t('more_messages', { count: itemsRemaining }),
        sender: opts.digestSender,
      });
      parts.push({
        jobIds: remainingJobs,
        originMessageIds: items.slice(i).flatMap((it) => (it.originMessageId ? [it.originMessageId] : [])),
        partIndex: 0,
      });
      break;
    }

    if (slotsRemaining === 0) {
      summarizedJobIds.push(...items.slice(i).map((it) => it.jobId));
      break;
    }

    const item = items[i]!;

    if (isSingleTextMessage(item)) {
      const merged = mergeConsecutiveTexts(items, i, slotsRemaining, opts);
      messages.push(merged.message);
      parts.push(merged.part);
      includedJobIds.push(...merged.jobIds);
      i += merged.itemCount;
    } else {
      // Media or sticker
      if (messages.length + item.objects.length <= slotsRemaining || slotsRemaining > 1) {
        for (let p = 0; p < item.objects.length; p++) {
          if (messages.length >= maxObjects - 1 && i < items.length - 1) {
            // Must save slot for summary
            break;
          }
          messages.push(item.objects[p]!);
          parts.push({
            jobIds: [item.jobId],
            originMessageIds: item.originMessageId ? [item.originMessageId] : [],
            partIndex: p,
          });
        }
        includedJobIds.push(item.jobId);
        i++;
      } else {
        // Overflow
        const remainingJobs = items.slice(i).map((it) => it.jobId);
        summarizedJobIds.push(...remainingJobs);
        messages.push({
          type: 'text',
          text: opts.t('more_messages', { count: itemsRemaining }),
          sender: opts.digestSender,
        });
        parts.push({
          jobIds: remainingJobs,
          originMessageIds: items.slice(i).flatMap((it) => (it.originMessageId ? [it.originMessageId] : [])),
          partIndex: 0,
        });
        break;
      }
    }
  }

  return { messages, parts, includedJobIds, summarizedJobIds };
}

function isSingleTextMessage(item: PackItem): boolean {
  return item.objects.length === 1 && (item.objects[0]!.type === 'text' || item.objects[0]!.type === 'textV2');
}

function mergeConsecutiveTexts(
  items: PackItem[],
  startIndex: number,
  _maxSlots: number,
  opts: PackOptions,
): { message: OutboundMessage; part: PackedPart; jobIds: string[]; itemCount: number } {
  const jobIds: string[] = [];
  const originMessageIds: string[] = [];
  const textLines: string[] = [];

  let count = 0;
  for (let idx = startIndex; idx < items.length; idx++) {
    const it = items[idx]!;
    if (!isSingleTextMessage(it)) break;

    const rawMsg = it.objects[0]!;
    const rawText = rawMsg.type === 'text' || rawMsg.type === 'textV2' ? (rawMsg.text ?? '') : '';
    const line = `${it.authorLabel}: ${rawText}`;

    // Check if adding this line exceeds 5000 UTF-16 units
    const candidate = textLines.length === 0 ? line : textLines.join('\n') + '\n' + line;
    if (candidate.length > MAX_DIGEST_TEXT) {
      if (textLines.length === 0) {
        textLines.push(fit(line, MAX_DIGEST_TEXT));
        jobIds.push(it.jobId);
        if (it.originMessageId) originMessageIds.push(it.originMessageId);
        count++;
      }
      break;
    }

    textLines.push(line);
    jobIds.push(it.jobId);
    if (it.originMessageId) originMessageIds.push(it.originMessageId);
    count++;
  }

  const mergedText = textLines.join('\n');
  return {
    message: {
      type: 'text',
      text: mergedText,
      sender: opts.digestSender,
    },
    part: {
      jobIds,
      originMessageIds,
      partIndex: 0,
    },
    jobIds,
    itemCount: count,
  };
}
