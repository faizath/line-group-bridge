import type { AppContext } from '../app/context.js';
import type { BridgeRow, GroupRow, JobRow, LineUserRow, OriginRow } from '../core/rows.js';
import { translator, type MessageKey, type Translate } from '../i18n/index.js';
import { noticeMessage, senderName, translate } from '../translate/translate.js';
import type { PackItem, TranslateContext } from '../translate/types.js';
import { resolveEditQuote, resolveQuote } from './quotes.js';

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'file']);

export interface RenderOutcome {
  items: PackItem[];
  /** Jobs that must not be delivered any more (origin unsent, purged or gone). */
  dropped: { jobId: string; reason: string }[];
}

/** Bridge icon used for digests, notices and authors without an avatar. */
export async function bridgeIconUrl(ctx: AppContext, bridge: BridgeRow): Promise<string> {
  return bridge.default_icon_url ?? (await ctx.media.defaultIconUrl());
}

export function renderNoticeText(t: Translate, notice: { key: string; vars?: Record<string, string | number> }): string {
  return t(notice.key as MessageKey, notice.vars);
}

/** Turns jobs into outbound message objects for one target group (translator inputs gathered from the DB). */
export async function renderJobs(ctx: AppContext, bridge: BridgeRow, target: GroupRow, jobs: JobRow[]): Promise<RenderOutcome> {
  const t = translator(bridge.locale);
  const iconUrl = await bridgeIconUrl(ctx, bridge);
  const out: RenderOutcome = { items: [], dropped: [] };
  const groups = new Map<string, GroupRow | null>();
  const users = new Map<string, LineUserRow | null>();
  let targetMembers: Set<string> | null = null;

  for (const job of jobs) {
    if (job.kind === 'notice' || job.kind === 'unsend_notice') {
      const text = renderNoticeText(t, job.notice ?? { key: 'snippet_message' });
      out.items.push({
        jobId: job.id,
        originMessageId: null,
        authorLabel: bridge.name,
        // Unsend notices never quote the copy: quoting would redisplay the content (ADR-005).
        objects: [noticeMessage(job.kind === 'unsend_notice' ? `🚫 ${text}` : text, { name: bridge.name, iconUrl })],
      });
      continue;
    }

    const { rows } = await ctx.db.query<OriginRow>('select * from origin_messages where message_id = $1', [job.origin_message_id]);
    const origin = rows[0];
    if (!origin || origin.unsent_at || origin.purged_at) {
      out.dropped.push({ jobId: job.id, reason: origin?.unsent_at ? 'unsent' : 'origin purged' });
      continue;
    }

    if (!groups.has(origin.group_id)) {
      const g = await ctx.db.query<GroupRow>('select * from member_groups where group_id = $1', [origin.group_id]);
      groups.set(origin.group_id, g.rows[0] ?? null);
    }
    const originGroup = groups.get(origin.group_id);
    const shortTag = originGroup?.short_tag ?? '?';

    let author: LineUserRow | null = null;
    if (origin.user_id) {
      if (!users.has(origin.user_id)) {
        const u = await ctx.db.query<LineUserRow>('select * from line_users where user_id = $1', [origin.user_id]);
        users.set(origin.user_id, u.rows[0] ?? null);
      }
      author = users.get(origin.user_id) ?? null;
    }

    if (!targetMembers) {
      const m = await ctx.db.query<{ user_id: string }>(
        'select user_id from group_memberships where group_id = $1 and left_at is null',
        [target.group_id],
      );
      targetMembers = new Set(m.rows.map((r) => r.user_id));
    }

    const quote =
      job.kind === 'edit'
        ? await resolveEditQuote(ctx.db, origin, target.group_id, t)
        : origin.quoted_message_id
          ? await resolveQuote(ctx.db, origin.quoted_message_id, origin.group_id, target.group_id, t)
          : null;
    const meta = origin.meta ?? {};
    const media = MEDIA_TYPES.has(origin.type) ? await ctx.media.refs(origin.message_id, origin.type, meta, origin.media_state) : null;

    const tctx: TranslateContext = {
      bridge: { name: bridge.name, originTagStyle: bridge.origin_tag_style, iconUrl },
      originGroup: { shortTag },
      author: {
        displayName: author?.display_name ?? null,
        iconUrl: author?.icon_object_key ? ctx.media.publicUrl(author.icon_object_key) : null,
      },
      quote,
      media,
      isStickerSendable: (p, s) => ctx.stickers.isSendable(p, s),
      fallbackStep: job.fallback_step,
      forbiddenWords: ctx.config.FORBIDDEN_NAME_WORDS,
      targetMemberIds: targetMembers,
      t,
    };
    out.items.push({
      jobId: job.id,
      originMessageId: origin.message_id,
      authorLabel: senderName(author?.display_name ?? null, shortTag, 'name_suffix', ctx.config.FORBIDDEN_NAME_WORDS, t),
      objects: translate({ messageId: origin.message_id, type: origin.type, text: origin.text, meta }, tctx, job.kind === 'edit' ? 'edit' : 'relay'),
    });
  }
  return out;
}
