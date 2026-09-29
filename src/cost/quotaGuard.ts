import type { AppContext } from '../app/context.js';
import type { Queryable } from '../db/db.js';
import { attachedGroups } from '../core/groups.js';
import { enqueueNotice, releaseStrictHolds } from '../core/jobs.js';
import type { BridgeRow } from '../core/rows.js';
import { getState, setState } from '../core/state.js';
import { alert } from '../logger.js';
import { localDay, monthToDate } from './usage.js';

const STATE_KEY = 'quota_guard';
const DAY_MS = 24 * 60 * 60 * 1000;
/** Projection alert levels (US-17); the configurable QUOTA_ALERT_PCT is added to these. */
const BASE_ALERT_LEVELS = [50, 95];

export type ForceReason = 'monthly_limit' | 'quota_hard' | 'budget';

interface GuardState {
  /** Global push stop after LINE answered 429 "monthly limit" (FR-COST-7). */
  stopped: boolean;
  stoppedAt?: string;
  /** YYYY-MM the state belongs to; a different month means rollover. */
  month: string;
  /** Alert names already raised this month. */
  alerted: string[];
}

export interface QuotaStatus {
  limit: number | null;
  used: number | null;
  projected: number | null;
  takenAt: Date | null;
  stopped: boolean;
}

/** Quota guard: projections, alerts and automatic strict-economy switching (FR-COST-5..8). */
export class QuotaGuard {
  constructor(private ctx: AppContext) {}

  private async state(q: Queryable = this.ctx.db): Promise<GuardState> {
    const month = localDay(this.ctx.clock.now(), this.ctx.config.QUOTA_TZ).month;
    return (await getState<GuardState>(q, STATE_KEY)) ?? { stopped: false, month, alerted: [] };
  }

  /** False while pushes are globally stopped or the bridge exceeded its own budget. Replies are never blocked. */
  async canPush(bridge: BridgeRow): Promise<boolean> {
    const st = await this.state();
    if (st.stopped) return false;
    if (bridge.monthly_budget !== null) {
      const day = localDay(this.ctx.clock.now(), this.ctx.config.QUOTA_TZ);
      const mtd = await monthToDate(this.ctx.db, bridge.id, day);
      if (mtd.billed >= bridge.monthly_budget) {
        await this.forceStrict([bridge], 'budget');
        alert(this.ctx.log, 'bridge_budget_exhausted', { bridgeId: bridge.id, budget: bridge.monthly_budget, billed: mtd.billed });
        return false;
      }
    }
    return true;
  }

  /** LINE refused a push with "You have reached your monthly limit." */
  async onMonthlyLimit(): Promise<void> {
    const now = this.ctx.clock.now();
    const st = await this.state();
    if (st.stopped) return;
    await setState(this.ctx.db, STATE_KEY, { ...st, stopped: true, stoppedAt: now.toISOString() }, now);
    alert(this.ctx.log, 'quota_monthly_limit_reached');
    const { rows } = await this.ctx.db.query<BridgeRow>(`select * from bridges where status = 'active'`);
    await this.forceStrict(rows, 'monthly_limit');
  }

  /** Operator command (POST /admin/v1/quota/resume) or month rollover: lift the stop and restore modes. */
  async resume(reason: 'operator' | 'rollover'): Promise<void> {
    const now = this.ctx.clock.now();
    const month = localDay(now, this.ctx.config.QUOTA_TZ).month;
    const st = await this.state();
    await setState(this.ctx.db, STATE_KEY, { stopped: false, month, alerted: reason === 'rollover' ? [] : st.alerted }, now);
    const reasons = reason === 'rollover' ? ['monthly_limit', 'quota_hard', 'budget'] : ['monthly_limit', 'quota_hard'];
    const { rows } = await this.ctx.db.query<BridgeRow>(
      `update bridges set delivery_mode = coalesce(mode_before_force, delivery_mode), mode_before_force = null, forced_mode_reason = null
       where forced_mode_reason = any($1::text[]) returning *`,
      [reasons],
    );
    for (const b of rows) await releaseStrictHolds(this.ctx.db, b, now);
    this.ctx.log.info({ reason, bridges: rows.length }, 'quota guard resumed pushes');
  }

  private async forceStrict(bridges: BridgeRow[], reason: ForceReason): Promise<void> {
    const now = this.ctx.clock.now();
    for (const b of bridges) {
      const { rowCount } = await this.ctx.db.query(
        `update bridges set mode_before_force = coalesce(mode_before_force, delivery_mode), delivery_mode = 'strict_economy', forced_mode_reason = $2
         where id = $1 and forced_mode_reason is null`,
        [b.id, reason],
      );
      if (rowCount === 0) continue;
      // Organizers learn about it; in strict economy the notice only travels through free replies.
      const groups = await attachedGroups(this.ctx.db, b.id);
      await enqueueNotice(
        this.ctx.db,
        { ...b, delivery_mode: 'strict_economy' },
        groups.map((g) => g.group_id),
        { key: reason === 'budget' ? 'notice_budget_exhausted' : 'notice_quota_strict' },
        now,
      );
    }
  }

  /** Polls LINE quota figures, records a snapshot, raises alerts and applies the hard threshold. */
  async poll(): Promise<QuotaStatus> {
    const { ctx } = this;
    const now = ctx.clock.now();
    const day = localDay(now, ctx.config.QUOTA_TZ);
    let st = await this.state();
    if (st.month !== day.month) {
      if (st.stopped || (await this.hasForcedBridges())) await this.resume('rollover');
      st = { stopped: false, month: day.month, alerted: [] };
      await setState(ctx.db, STATE_KEY, st, now);
    }

    const [quota, consumption] = await Promise.all([ctx.line.getQuota(), ctx.line.getQuotaConsumption()]);
    const limit = quota.type === 'limited' && typeof quota.value === 'number' ? quota.value : null;
    const used = consumption.totalUsage;
    await ctx.db.query(
      `insert into quota_snapshots (taken_at, quota_type, quota_value, total_usage) values ($1, $2, $3, $4) on conflict do nothing`,
      [now, quota.type, limit, used],
    );
    ctx.metrics.quotaLimit.set(limit ?? -1);
    ctx.metrics.quotaUsage.set(used);

    const projected = await this.project(used, now);
    if (limit !== null && limit > 0) {
      const levels = [...new Set([...BASE_ALERT_LEVELS, ctx.config.QUOTA_ALERT_PCT])].sort((a, b) => a - b);
      const raised = new Set(st.alerted);
      for (const pct of levels) {
        const name = `quota_projected_${pct}`;
        if (projected >= (limit * pct) / 100 && !raised.has(name)) {
          alert(ctx.log, name, { limit, used, projected });
          raised.add(name);
        }
      }
      if (used >= (limit * ctx.config.QUOTA_HARD_PCT) / 100 && !raised.has('quota_hard')) {
        alert(ctx.log, 'quota_hard_threshold', { limit, used });
        raised.add('quota_hard');
        const { rows } = await ctx.db.query<BridgeRow>(`select * from bridges where status = 'active'`);
        await this.forceStrict(rows, 'quota_hard');
      }
      st = { ...(await this.state()), alerted: [...raised] };
      await setState(ctx.db, STATE_KEY, st, now);
    }
    return { limit, used, projected, takenAt: now, stopped: st.stopped };
  }

  private async hasForcedBridges(): Promise<boolean> {
    const { rows } = await this.ctx.db.query<{ n: number }>(`select count(*) as n from bridges where forced_mode_reason is not null`);
    return (rows[0]?.n ?? 0) > 0;
  }

  /** projected = used + rate_last_24h × days_remaining ([06] §5). */
  async project(used: number, now: Date): Promise<number> {
    const day = localDay(now, this.ctx.config.QUOTA_TZ);
    const { rows } = await this.ctx.db.query<{ total_usage: number; taken_at: Date }>(
      `select total_usage, taken_at from quota_snapshots where taken_at <= $1 and taken_at >= $2 order by taken_at desc limit 1`,
      [new Date(now.getTime() - DAY_MS), new Date(now.getTime() - 2 * DAY_MS)],
    );
    let rate: number;
    const prev = rows[0];
    if (prev && prev.total_usage <= used) {
      rate = ((used - prev.total_usage) / (now.getTime() - prev.taken_at.getTime())) * DAY_MS;
    } else {
      // No usable snapshot yet: fall back to our own billed estimate over the last 24 h.
      const r = await this.ctx.db.query<{ billed: number | null }>(
        `select sum(billed_estimate)::bigint as billed from relay_attempts where started_at > $1 and http_status in (200, 409)`,
        [new Date(now.getTime() - DAY_MS)],
      );
      rate = r.rows[0]?.billed ?? 0;
    }
    const daysRemaining = day.daysInMonth - day.dayOfMonth;
    return Math.round(used + rate * daysRemaining);
  }

  /** Latest snapshot for status displays. */
  async status(): Promise<QuotaStatus> {
    const { rows } = await this.ctx.db.query<{ quota_value: number | null; total_usage: number | null; taken_at: Date }>(
      'select quota_value, total_usage, taken_at from quota_snapshots order by taken_at desc limit 1',
    );
    const st = await this.state();
    const snap = rows[0];
    if (!snap) return { limit: null, used: null, projected: null, takenAt: null, stopped: st.stopped };
    const used = snap.total_usage ?? 0;
    return { limit: snap.quota_value, used, projected: await this.project(used, this.ctx.clock.now()), takenAt: snap.taken_at, stopped: st.stopped };
  }

  /**
   * Projected monthly billed messages if the bridge relayed its last 7 days of traffic in immediate
   * mode: Σ over origin groups of messages × (M − m_origin), scaled to 30 days ([06] §2, §7).
   */
  async immediateMonthlyEstimate(bridgeId: string): Promise<number> {
    const now = this.ctx.clock.now();
    const groups = await attachedGroups(this.ctx.db, bridgeId);
    const total = groups.reduce((s, g) => s + (g.member_count ?? 0), 0);
    const { rows } = await this.ctx.db.query<{ group_id: string; n: number }>(
      `select group_id, count(*) as n from origin_messages where bridge_id = $1 and relayed and event_ts > $2 group by group_id`,
      [bridgeId, new Date(now.getTime() - 7 * DAY_MS)],
    );
    let weekly = 0;
    for (const r of rows) {
      const g = groups.find((x) => x.group_id === r.group_id);
      weekly += r.n * (total - (g?.member_count ?? 0));
    }
    return Math.round((weekly * 30) / 7);
  }
}
