import type { AppContext } from '../app/context.js';
import { DELIVERY_MODES, LOCALES, type DeliveryMode, type Locale } from '../config.js';
import {
  attachedGroups,
  cancelTargetJobs,
  getBridge,
  getGroup,
  groupLabel,
  nextShortTag,
  refreshGroupMeta,
} from '../core/groups.js';
import { enqueueNotice, releaseStrictHolds } from '../core/jobs.js';
import { registerToken, replyMessages } from '../core/replyTokens.js';
import type { BridgeRow, GroupRow, Role } from '../core/rows.js';
import type { QuotaGuard } from '../cost/quotaGuard.js';
import { localDay, monthToDate } from '../cost/usage.js';
import type { Queryable } from '../db/db.js';
import { canonicalOrigin } from '../delivery/quotes.js';
import { translator, type MessageKey, type Translate } from '../i18n/index.js';
import type { InboundMessage, OutboundMessage } from '../line/types.js';
import { addMs } from '../util/clock.js';
import { newLinkCode, normalizeLinkCode, uuid } from '../util/ids.js';
import { fit } from '../util/utf16.js';
import { parseCommand, type CommandWord, type ParsedCommand } from './parse.js';

const TEXT_LIMIT = 5000;
const DEFAULT_CODE_TTL_H = 24;
const MAX_CODE_TTL_H = 7 * 24;
const MAX_CODE_USES = 100;

export interface CommandEvent {
  groupId: string;
  userId: string | null;
  message: InboundMessage;
  replyToken: string | null;
  webhookEventId: string;
  receivedAt: Date;
}

type Level = 'member' | 'moderator' | 'admin' | 'owner' | 'operator';
const LEVEL_RANK: Record<Level, number> = { member: 0, moderator: 1, admin: 2, owner: 3, operator: 4 };

interface Invocation {
  ev: CommandEvent;
  cmd: ParsedCommand;
  userId: string;
  group: GroupRow;
  bridge: BridgeRow | null;
  level: Level;
  t: Translate;
}

class CommandError extends Error {
  constructor(
    readonly key: MessageKey,
    readonly vars: Record<string, string | number> = {},
  ) {
    super(key);
  }
}

/**
 * In-chat `/bridge …` commands ([10]). Commands are never relayed; answers go through the
 * command's own reply token (free), and bridge roles replace LINE group-admin status, which
 * the API does not expose (FR-CMD-*).
 */
export class Commands {
  constructor(
    private ctx: AppContext,
    private quota: QuotaGuard,
  ) {}

  parse(msg: InboundMessage): ParsedCommand | null {
    return parseCommand(msg, this.ctx.config.COMMAND_PREFIX);
  }

  async handle(ev: CommandEvent, cmd: ParsedCommand): Promise<void> {
    const { ctx } = this;
    const now = ctx.clock.now();
    // The command owns this reply token; the outbox flush must use another one (FR-COST-4).
    const token = ev.replyToken && (await registerToken(ctx.db, ev.replyToken, ev.groupId, ev.webhookEventId, ev.receivedAt, 'command')) ? ev.replyToken : null;

    const group = await getGroup(ctx.db, ev.groupId);
    const bridge = group?.bridge_id && group.state === 'attached' ? await getBridge(ctx.db, group.bridge_id) : null;
    const t = translator(bridge?.locale ?? ctx.config.LOCALE_DEFAULT);
    const p = ctx.config.COMMAND_PREFIX;

    let reply: string;
    let outcome = 'ok';
    let pushFallback = false;
    try {
      if (!ev.userId) throw new CommandError('cmd_no_user');
      if (!group) throw new CommandError('cmd_not_bridged', { p });
      const level = await this.levelOf(ev.userId, bridge);
      const inv: Invocation = { ev, cmd, userId: ev.userId, group, bridge, level, t };
      const res = await this.dispatch(inv);
      reply = res.text;
      pushFallback = res.pushFallback === true;
    } catch (err) {
      if (!(err instanceof CommandError)) throw err;
      outcome = err.key;
      reply = t(err.key, { p, ...err.vars });
    }

    await ctx.db.query(`insert into command_log (group_id, user_id, command, outcome, created_at) values ($1, $2, $3, $4, $5)`, [
      ev.groupId,
      ev.userId,
      cmd.name ?? 'unknown',
      outcome,
      now,
    ]);

    const messages: OutboundMessage[] = [{ type: 'text', text: fit(reply, TEXT_LIMIT) }];
    const replied = token ? await replyMessages(ctx, token, messages) : false;
    // Link codes are needed for setup, so they are the one reply that may fall back to a push (ADR-006).
    if (!replied && pushFallback) {
      try {
        await ctx.line.push(ev.groupId, messages, { retryKey: uuid() });
      } catch (err) {
        ctx.log.warn({ err, groupId: ev.groupId }, 'link-code push fallback failed');
      }
    }
  }

  private async levelOf(userId: string, bridge: BridgeRow | null): Promise<Level> {
    if (this.ctx.config.OPERATOR_USER_IDS.includes(userId)) return 'operator';
    if (!bridge) return 'member';
    const role = await roleOf(this.ctx.db, bridge.id, userId);
    return role ?? 'member';
  }

  private async dispatch(inv: Invocation): Promise<{ text: string; pushFallback?: boolean }> {
    const name = inv.cmd.name;
    switch (name) {
      case null:
        throw new CommandError('cmd_unknown');
      case 'help':
        return { text: this.help(inv) };
      case 'create':
        return this.create(inv);
      case 'join':
        return { text: await this.join(inv) };
      case 'optout':
      case 'optin':
        return { text: await this.optOut(inv, name === 'optout') };
      default:
        break;
    }
    const bridge = inv.bridge;
    if (!bridge) throw new CommandError('cmd_not_bridged');
    const ctx = { ...inv, bridge };
    switch (name) {
      case 'status':
        return { text: await this.status(ctx) };
      case 'code':
        require(inv, 'admin');
        return this.code(ctx);
      case 'leave':
        require(inv, 'admin');
        return { text: await this.leave(ctx, false) };
      case 'kick':
        require(inv, 'admin');
        return { text: await this.leave(ctx, true) };
      case 'rename':
        require(inv, 'admin');
        return { text: await this.rename(ctx) };
      case 'tag':
        require(inv, 'admin');
        return { text: await this.tag(ctx) };
      case 'mode':
        require(inv, 'admin');
        return { text: await this.mode(ctx) };
      case 'window':
        require(inv, 'admin');
        return { text: await this.window(ctx) };
      case 'hold':
        require(inv, 'admin');
        return { text: await this.hold(ctx) };
      case 'pause':
      case 'resume':
        require(inv, 'moderator');
        return { text: await this.pause(ctx, name === 'pause') };
      case 'mute':
      case 'unmute':
        require(inv, 'moderator');
        return { text: await this.mute(ctx, name === 'mute') };
      case 'admin':
      case 'mod':
        return { text: await this.roles(ctx, name === 'admin' ? 'admin' : 'moderator') };
      case 'silent':
        require(inv, 'admin');
        return { text: await this.toggle(ctx, 'notification_disabled', 'silent_on', 'silent_off', inv.cmd.args[0]) };
      case 'notices':
        require(inv, 'admin');
        return { text: await this.notices(ctx) };
      case 'locale':
        require(inv, 'admin');
        return { text: await this.locale(ctx) };
      case 'budget':
        require(inv, 'admin');
        return { text: await this.budget(ctx) };
      case 'style':
        require(inv, 'admin');
        return { text: await this.style(ctx) };
    }
  }

  private help(inv: Invocation): string {
    const p = this.ctx.config.COMMAND_PREFIX;
    const keys: MessageKey[] = ['help_member'];
    if (LEVEL_RANK[inv.level] >= LEVEL_RANK.moderator) keys.push('help_moderator');
    if (LEVEL_RANK[inv.level] >= LEVEL_RANK.admin) keys.push('help_admin');
    return keys.map((k) => inv.t(k, { p })).join('\n');
  }

  private async create(inv: Invocation): Promise<{ text: string; pushFallback: boolean }> {
    const { ctx } = this;
    const cfg = ctx.config;
    if (inv.bridge) throw new CommandError('create_exists', { bridge: inv.bridge.name });
    const allowed =
      inv.level === 'operator' ||
      cfg.BRIDGE_CREATE_POLICY === 'anyone' ||
      (cfg.BRIDGE_CREATE_POLICY === 'allowlist' && cfg.BRIDGE_CREATE_ALLOWLIST.includes(inv.userId));
    if (!allowed) throw new CommandError('create_policy');
    const name = fit(inv.cmd.rest.trim(), 50);
    if (!name) throw new CommandError('cmd_usage', { usage: `${cfg.COMMAND_PREFIX} create <name>` });

    const now = ctx.clock.now();
    const bridgeId = uuid();
    const code = newLinkCode();
    await ctx.db.tx(async (q) => {
      await q.query(
        `insert into bridges (id, channel_id, name, delivery_mode, batch_window_ms, max_hold_s, locale, created_by, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [bridgeId, cfg.channelId, name, cfg.DEFAULT_DELIVERY_MODE, cfg.BATCH_WINDOW_MS, cfg.ECONOMY_MAX_HOLD_S, cfg.LOCALE_DEFAULT, inv.userId, now],
      );
      await q.query(
        `update member_groups set bridge_id = $2, state = 'attached', short_tag = 'A', attached_at = $3, relay_in = true, relay_out = true where group_id = $1`,
        [inv.group.group_id, bridgeId, now],
      );
      await q.query(`insert into bridge_admins (bridge_id, user_id, role) values ($1, $2, 'owner')`, [bridgeId, inv.userId]);
      await q.query(`insert into link_codes (code, bridge_id, created_by, expires_at, max_uses) values ($1, $2, $3, $4, 1)`, [
        code,
        bridgeId,
        inv.userId,
        addMs(now, DEFAULT_CODE_TTL_H * 3_600_000),
      ]);
    });
    const t = translator(cfg.LOCALE_DEFAULT);
    return {
      text: t('create_ok', { bridge: name, tag: 'A', code, ttl: DEFAULT_CODE_TTL_H, uses: 1, p: cfg.COMMAND_PREFIX }),
      pushFallback: true,
    };
  }

  private async code(inv: Invocation & { bridge: BridgeRow }): Promise<{ text: string; pushFallback: boolean }> {
    const uses = inv.cmd.args[0] ? Number.parseInt(inv.cmd.args[0], 10) : 1;
    const ttl = inv.cmd.args[1] ? Number.parseInt(inv.cmd.args[1].replace(/h$/i, ''), 10) : DEFAULT_CODE_TTL_H;
    if (!Number.isInteger(uses) || uses < 1 || uses > MAX_CODE_USES || !Number.isInteger(ttl) || ttl < 1 || ttl > MAX_CODE_TTL_H) {
      throw new CommandError('cmd_usage', { usage: `${this.ctx.config.COMMAND_PREFIX} code [uses 1-${MAX_CODE_USES}] [hours 1-${MAX_CODE_TTL_H}]` });
    }
    const code = newLinkCode();
    await this.ctx.db.query(`insert into link_codes (code, bridge_id, created_by, expires_at, max_uses) values ($1, $2, $3, $4, $5)`, [
      code,
      inv.bridge.id,
      inv.userId,
      addMs(this.ctx.clock.now(), ttl * 3_600_000),
      uses,
    ]);
    return { text: inv.t('code_ok', { code, ttl, uses, p: this.ctx.config.COMMAND_PREFIX }), pushFallback: true };
  }

  private async join(inv: Invocation): Promise<string> {
    const { ctx } = this;
    const now = ctx.clock.now();
    if (inv.bridge) throw new CommandError('join_already', { bridge: inv.bridge.name });
    const code = normalizeLinkCode(inv.cmd.args[0] ?? '');
    if (!code) throw new CommandError('join_invalid');

    const result = await ctx.db.tx(async (q) => {
      const { rows } = await q.query<{ bridge_id: string }>(
        `update link_codes set uses = uses + 1 where code = $1 and expires_at > $2 and uses < max_uses returning bridge_id`,
        [code, now],
      );
      const bridgeId = rows[0]?.bridge_id;
      if (!bridgeId) throw new CommandError('join_invalid');
      const bridge = (await q.query<BridgeRow>('select * from bridges where id = $1', [bridgeId])).rows[0];
      if (!bridge || bridge.status !== 'active') throw new CommandError('join_invalid');
      if (ctx.config.BRIDGE_JOIN_REQUIRES_ADMIN && inv.level !== 'operator') {
        const role = await roleOf(q, bridge.id, inv.userId);
        if (role !== 'owner' && role !== 'admin') throw new CommandError('cmd_denied');
      }
      const count = await q.query<{ n: number }>(`select count(*) as n from member_groups where bridge_id = $1 and state = 'attached'`, [bridge.id]);
      if ((count.rows[0]?.n ?? 0) >= ctx.config.MAX_GROUPS_PER_BRIDGE) {
        throw new CommandError('join_full', { bridge: bridge.name, max: ctx.config.MAX_GROUPS_PER_BRIDGE });
      }
      const tag = await nextShortTag(q, bridge.id);
      await q.query(
        `update member_groups set bridge_id = $2, state = 'attached', short_tag = $3, attached_at = $4, relay_in = true, relay_out = true where group_id = $1`,
        [inv.group.group_id, bridge.id, tag, now],
      );
      return { bridge, tag };
    });

    const groups = await attachedGroups(ctx.db, result.bridge.id);
    const others = groups.filter((g) => g.group_id !== inv.group.group_id);
    if (result.bridge.notices_join && others.length > 0) {
      await enqueueNotice(ctx.db, result.bridge, others.map((g) => g.group_id), {
        key: 'notice_group_joined',
        vars: { group: groupLabel({ ...inv.group, short_tag: result.tag }) },
      }, now);
    }
    await refreshGroupMeta(ctx, inv.group.group_id);
    const t = translator(result.bridge.locale);
    const lines = [
      t('join_ok', { bridge: result.bridge.name, tag: result.tag, groups: others.map((g) => groupLabel(g)).join(', ') || '—' }),
    ];
    if (ctx.config.PRIVACY_URL) lines.push(t('privacy_line', { url: ctx.config.PRIVACY_URL }));
    return lines.join('\n');
  }

  private async leave(inv: Invocation & { bridge: BridgeRow }, kick: boolean): Promise<string> {
    const { ctx } = this;
    const now = ctx.clock.now();
    await ctx.db.tx(async (q) => {
      await q.query(
        `update member_groups set state = $2, bridge_id = null, short_tag = null, attached_at = null where group_id = $1`,
        [inv.group.group_id, kick ? 'bot_removed' : 'detached'],
      );
      await cancelTargetJobs(q, inv.group.group_id, kick ? 'bot left group' : 'group detached');
    });
    const others = (await attachedGroups(ctx.db, inv.bridge.id)).map((g) => g.group_id);
    if (inv.bridge.notices_leave && others.length > 0) {
      await enqueueNotice(ctx.db, inv.bridge, others, { key: 'notice_group_left', vars: { group: groupLabel(inv.group) } }, now);
    }
    if (kick) {
      // Reply first (the token dies with the membership), then leave.
      const text = inv.t('kick_ok');
      setImmediate(() => {
        ctx.line.leaveGroup(inv.group.group_id).catch((err: unknown) => ctx.log.warn({ err, groupId: inv.group.group_id }, 'leave group failed'));
      });
      return text;
    }
    return inv.t('leave_ok', { bridge: inv.bridge.name });
  }

  private async rename(inv: Invocation & { bridge: BridgeRow }): Promise<string> {
    const name = fit(inv.cmd.rest.trim(), 50);
    if (!name) throw new CommandError('cmd_usage', { usage: `${this.ctx.config.COMMAND_PREFIX} rename <name>` });
    await this.ctx.db.query('update bridges set name = $2 where id = $1', [inv.bridge.id, name]);
    return inv.t('rename_ok', { bridge: name });
  }

  private async tag(inv: Invocation & { bridge: BridgeRow }): Promise<string> {
    const tag = (inv.cmd.args[0] ?? '').toUpperCase();
    if (!/^[\p{L}\p{N}]{1,3}$/u.test(tag)) throw new CommandError('tag_invalid');
    const { rows } = await this.ctx.db.query<{ n: number }>(
      'select count(*) as n from member_groups where bridge_id = $1 and short_tag = $2 and group_id <> $3',
      [inv.bridge.id, tag, inv.group.group_id],
    );
    if ((rows[0]?.n ?? 0) > 0) throw new CommandError('tag_invalid');
    await this.ctx.db.query('update member_groups set short_tag = $2 where group_id = $1', [inv.group.group_id, tag]);
    return inv.t('tag_ok', { tag });
  }

  private async mode(inv: Invocation & { bridge: BridgeRow }): Promise<string> {
    const { ctx } = this;
    const raw = (inv.cmd.args[0] ?? '').toLowerCase();
    const mode = (raw === 'strict' ? 'strict_economy' : raw) as DeliveryMode;
    if (!DELIVERY_MODES.includes(mode)) {
      throw new CommandError('cmd_usage', { usage: `${ctx.config.COMMAND_PREFIX} mode <immediate|batched|economy|strict>` });
    }
    // Immediate mode is the expensive one: show the projected cost first ([06] §7).
    if (mode === 'immediate' && (inv.cmd.args[1] ?? '').toLowerCase() !== 'confirm') {
      const estimate = await this.quota.immediateMonthlyEstimate(inv.bridge.id);
      return inv.t('mode_immediate_warning', { estimate: estimate.toLocaleString('en-US'), p: ctx.config.COMMAND_PREFIX });
    }
    const { rows } = await ctx.db.query<BridgeRow>(
      `update bridges set delivery_mode = $2, forced_mode_reason = null, mode_before_force = null where id = $1 returning *`,
      [inv.bridge.id, mode],
    );
    if (rows[0]) await releaseStrictHolds(ctx.db, rows[0], ctx.clock.now());
    return inv.t('mode_ok', { mode: inv.t(`mode_${mode}` as MessageKey) });
  }

  private async window(inv: Invocation & { bridge: BridgeRow }): Promise<string> {
    const seconds = Number(inv.cmd.args[0]);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) {
      throw new CommandError('cmd_usage', { usage: `${this.ctx.config.COMMAND_PREFIX} window <1-60>` });
    }
    await this.ctx.db.query('update bridges set batch_window_ms = $2 where id = $1', [inv.bridge.id, seconds * 1000]);
    return inv.t('window_ok', { seconds });
  }

  private async hold(inv: Invocation & { bridge: BridgeRow }): Promise<string> {
    const arg = (inv.cmd.args[0] ?? '').toLowerCase();
    if (arg === 'off') {
      await this.ctx.db.query('update bridges set max_hold_s = null where id = $1', [inv.bridge.id]);
      return inv.t('hold_off');
    }
    const minutes = Number(arg);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
      throw new CommandError('cmd_usage', { usage: `${this.ctx.config.COMMAND_PREFIX} hold <minutes|off>` });
    }
    const { rows } = await this.ctx.db.query<BridgeRow>('update bridges set max_hold_s = $2 where id = $1 returning *', [
      inv.bridge.id,
      minutes * 60,
    ]);
    if (rows[0]) await releaseStrictHolds(this.ctx.db, rows[0], this.ctx.clock.now());
    return inv.t('hold_ok', { minutes });
  }

  private async pause(inv: Invocation & { bridge: BridgeRow }, pause: boolean): Promise<string> {
    const { ctx } = this;
    if (!pause) {
      await ctx.db.query('update member_groups set relay_in = true, relay_out = true where group_id = $1', [inv.group.group_id]);
      return inv.t('resume_ok');
    }
    const dir = (inv.cmd.args[0] ?? 'both').toLowerCase();
    if (dir !== 'in' && dir !== 'out' && dir !== 'both') {
      throw new CommandError('cmd_usage', { usage: `${ctx.config.COMMAND_PREFIX} pause [in|out|both]` });
    }
    await ctx.db.tx(async (q) => {
      await q.query(
        `update member_groups set relay_in = case when $2 then false else relay_in end, relay_out = case when $3 then false else relay_out end
         where group_id = $1`,
        [inv.group.group_id, dir !== 'out', dir !== 'in'],
      );
      if (dir !== 'out') await cancelTargetJobs(q, inv.group.group_id, 'paused (in)');
    });
    return inv.t('pause_ok', { direction: inv.t(`pause_${dir}` as MessageKey) });
  }

  /** Target user from the first non-bot mention, else from the author of the quoted message. */
  private async targetUser(inv: Invocation & { bridge: BridgeRow }): Promise<{ userId: string; label: string }> {
    const m = inv.cmd.mentioned[0];
    if (m) {
      if (!m.userId) throw new CommandError('target_no_consent');
      const text = inv.ev.message.text ?? '';
      return { userId: m.userId, label: text.slice(m.index, m.index + m.length) };
    }
    const quoted = inv.ev.message.quotedMessageId;
    if (quoted) {
      const origin = await canonicalOrigin(this.ctx.db, quoted, inv.group.group_id);
      if (origin?.user_id) {
        const { rows } = await this.ctx.db.query<{ display_name: string | null }>('select display_name from line_users where user_id = $1', [
          origin.user_id,
        ]);
        return { userId: origin.user_id, label: rows[0]?.display_name ?? inv.t('line_user') };
      }
      if (origin) throw new CommandError('target_no_consent');
    }
    throw new CommandError('mute_need_target');
  }

  private async mute(inv: Invocation & { bridge: BridgeRow }, mute: boolean): Promise<string> {
    const target = await this.targetUser(inv);
    if (mute) {
      await this.ctx.db.query(
        `insert into bridge_mutes (bridge_id, user_id, muted_by) values ($1, $2, $3) on conflict do nothing`,
        [inv.bridge.id, target.userId, inv.userId],
      );
      return inv.t('mute_ok', { user: target.label });
    }
    await this.ctx.db.query('delete from bridge_mutes where bridge_id = $1 and user_id = $2', [inv.bridge.id, target.userId]);
    return inv.t('unmute_ok', { user: target.label });
  }

  private async roles(inv: Invocation & { bridge: BridgeRow }, role: 'admin' | 'moderator'): Promise<string> {
    // Admins are appointed by the owner (or an operator); moderators by admins and above.
    require(inv, role === 'admin' ? 'owner' : 'admin');
    const action = (inv.cmd.args[0] ?? '').toLowerCase();
    if (action !== 'add' && action !== 'remove') {
      throw new CommandError('cmd_usage', { usage: `${this.ctx.config.COMMAND_PREFIX} ${role === 'admin' ? 'admin' : 'mod'} <add|remove> @user` });
    }
    const target = await this.targetUser(inv);
    const current = await roleOf(this.ctx.db, inv.bridge.id, target.userId);
    if (current === 'owner') throw new CommandError('role_owner_protected');
    const roleName = inv.t(`role_${role}` as MessageKey);
    if (action === 'add') {
      await this.ctx.db.query(
        `insert into bridge_admins (bridge_id, user_id, role) values ($1, $2, $3)
         on conflict (bridge_id, user_id) do update set role = excluded.role`,
        [inv.bridge.id, target.userId, role],
      );
      return inv.t('role_added', { user: target.label, role: roleName });
    }
    await this.ctx.db.query('delete from bridge_admins where bridge_id = $1 and user_id = $2 and role = $3', [
      inv.bridge.id,
      target.userId,
      role,
    ]);
    return inv.t('role_removed', { user: target.label, role: roleName });
  }

  private async toggle(
    inv: Invocation & { bridge: BridgeRow },
    column: 'notification_disabled',
    onKey: MessageKey,
    offKey: MessageKey,
    arg: string | undefined,
  ): Promise<string> {
    const value = parseOnOff(arg);
    if (value === null) throw new CommandError('cmd_usage', { usage: `${this.ctx.config.COMMAND_PREFIX} ${inv.cmd.name} <on|off>` });
    await this.ctx.db.query(`update bridges set ${column} = $2 where id = $1`, [inv.bridge.id, value]);
    return inv.t(value ? onKey : offKey);
  }

  private async notices(inv: Invocation & { bridge: BridgeRow }): Promise<string> {
    const kind = (inv.cmd.args[0] ?? '').toLowerCase();
    const value = parseOnOff(inv.cmd.args[1]);
    const column = ({ join: 'notices_join', leave: 'notices_leave', unsend: 'notices_unsend' } as Record<string, string>)[kind];
    if (!column || value === null) {
      throw new CommandError('cmd_usage', { usage: `${this.ctx.config.COMMAND_PREFIX} notices <join|leave|unsend> <on|off>` });
    }
    await this.ctx.db.query(`update bridges set ${column} = $2 where id = $1`, [inv.bridge.id, value]);
    return inv.t('notices_ok', { kind, state: inv.t(value ? 'state_on' : 'state_off') });
  }

  private async locale(inv: Invocation & { bridge: BridgeRow }): Promise<string> {
    const arg = inv.cmd.args[0] ?? '';
    const locale = LOCALES.find((l) => l.toLowerCase() === arg.toLowerCase());
    if (!locale) throw new CommandError('cmd_usage', { usage: `${this.ctx.config.COMMAND_PREFIX} locale <${LOCALES.join('|')}>` });
    await this.ctx.db.query('update bridges set locale = $2 where id = $1', [inv.bridge.id, locale]);
    return translator(locale as Locale)('locale_ok', { locale });
  }

  private async budget(inv: Invocation & { bridge: BridgeRow }): Promise<string> {
    const arg = (inv.cmd.args[0] ?? '').toLowerCase().replace(/[,_]/g, '');
    if (arg === 'off') {
      const { rows } = await this.ctx.db.query<BridgeRow>(
        `update bridges set monthly_budget = null,
           delivery_mode = case when forced_mode_reason = 'budget' then coalesce(mode_before_force, delivery_mode) else delivery_mode end,
           mode_before_force = case when forced_mode_reason = 'budget' then null else mode_before_force end,
           forced_mode_reason = case when forced_mode_reason = 'budget' then null else forced_mode_reason end
         where id = $1 returning *`,
        [inv.bridge.id],
      );
      if (rows[0]) await releaseStrictHolds(this.ctx.db, rows[0], this.ctx.clock.now());
      return inv.t('budget_off');
    }
    const n = Number(arg);
    if (!Number.isInteger(n) || n < 1) throw new CommandError('cmd_usage', { usage: `${this.ctx.config.COMMAND_PREFIX} budget <messages|off>` });
    await this.ctx.db.query('update bridges set monthly_budget = $2 where id = $1', [inv.bridge.id, n]);
    return inv.t('budget_ok', { budget: n.toLocaleString('en-US') });
  }

  private async style(inv: Invocation & { bridge: BridgeRow }): Promise<string> {
    const arg = (inv.cmd.args[0] ?? '').toLowerCase();
    const style = ({ none: 'none', suffix: 'name_suffix', prefix: 'text_prefix' } as Record<string, string>)[arg];
    if (!style) throw new CommandError('cmd_usage', { usage: `${this.ctx.config.COMMAND_PREFIX} style <none|suffix|prefix>` });
    await this.ctx.db.query('update bridges set origin_tag_style = $2 where id = $1', [inv.bridge.id, style]);
    return inv.t('style_ok', { style: arg });
  }

  private async optOut(inv: Invocation, optOut: boolean): Promise<string> {
    await this.ctx.db.query(
      `insert into line_users (user_id, opted_out) values ($1, $2) on conflict (user_id) do update set opted_out = excluded.opted_out`,
      [inv.userId, optOut],
    );
    return inv.t(optOut ? 'optout_ok' : 'optin_ok', { p: this.ctx.config.COMMAND_PREFIX });
  }

  private async status(inv: Invocation & { bridge: BridgeRow }): Promise<string> {
    const { ctx } = this;
    const { t, bridge } = inv;
    const now = ctx.clock.now();
    const lines: string[] = [];
    const forced = bridge.forced_mode_reason ? t('status_forced', { reason: bridge.forced_mode_reason }) : '';
    lines.push(t('status_header', { bridge: bridge.name, mode: t(`mode_${bridge.delivery_mode}` as MessageKey), forced }));
    for (const g of await attachedGroups(ctx.db, bridge.id)) {
      const paused =
        !g.relay_in && !g.relay_out
          ? t('status_paused', { direction: t('pause_both') })
          : !g.relay_in
            ? t('status_paused', { direction: t('pause_in') })
            : !g.relay_out
              ? t('status_paused', { direction: t('pause_out') })
              : '';
      lines.push(t('status_group', { tag: g.short_tag ?? '?', name: g.name ?? '—', members: g.member_count ?? '?', paused }));
    }
    const mtd = await monthToDate(ctx.db, bridge.id, localDay(now, ctx.config.QUOTA_TZ));
    lines.push(t('status_usage', { billed: mtd.billed.toLocaleString('en-US'), pushes: mtd.pushes, replies: mtd.replies }));
    if (bridge.monthly_budget !== null) {
      lines.push(t('status_budget', { budget: bridge.monthly_budget.toLocaleString('en-US') }));
    }
    if (LEVEL_RANK[inv.level] >= LEVEL_RANK.admin) {
      const q = await this.quota.status();
      if (q.used !== null) {
        lines.push(
          q.limit === null
            ? t('status_quota_unlimited', { used: q.used.toLocaleString('en-US') })
            : t('status_quota', {
                used: q.used.toLocaleString('en-US'),
                limit: q.limit.toLocaleString('en-US'),
                projected: (q.projected ?? q.used).toLocaleString('en-US'),
              }),
        );
        if (q.limit !== null && q.projected !== null && q.projected >= (q.limit * ctx.config.QUOTA_ALERT_PCT) / 100) {
          lines.push(t('status_warning', { pct: ctx.config.QUOTA_ALERT_PCT }));
        }
      }
      if (q.stopped) lines.push(t('status_quota_stopped'));
    }
    return lines.join('\n');
  }
}

function require(inv: Invocation, level: Level): void {
  if (LEVEL_RANK[inv.level] < LEVEL_RANK[level]) throw new CommandError('cmd_denied');
}

function parseOnOff(arg: string | undefined): boolean | null {
  const v = (arg ?? '').toLowerCase();
  return v === 'on' ? true : v === 'off' ? false : null;
}

export async function roleOf(q: Queryable, bridgeId: string, userId: string): Promise<Role | null> {
  const { rows } = await q.query<{ role: Role }>('select role from bridge_admins where bridge_id = $1 and user_id = $2', [bridgeId, userId]);
  return rows[0]?.role ?? null;
}

export type { CommandWord };
