import type { Queryable } from '../db/db.js';

export interface LocalDay {
  /** YYYY-MM-DD in the quota timezone. */
  day: string;
  /** YYYY-MM */
  month: string;
  monthStart: string;
  dayOfMonth: number;
  daysInMonth: number;
}

/** Calendar position in the quota timezone (month rollover is JST for JP accounts; configurable). */
export function localDay(now: Date, timeZone: string): LocalDay {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const year = Number(get('year'));
  const month = Number(get('month'));
  const dayOfMonth = Number(get('day'));
  const mm = String(month).padStart(2, '0');
  return {
    day: `${year}-${mm}-${String(dayOfMonth).padStart(2, '0')}`,
    month: `${year}-${mm}`,
    monthStart: `${year}-${mm}-01`,
    dayOfMonth,
    daysInMonth: new Date(Date.UTC(year, month, 0)).getUTCDate(),
  };
}

export interface UsageDelta {
  pushes?: number;
  replies?: number;
  billed?: number;
  relayed?: number;
}

/** Per-bridge daily counters; the billed estimate is the target member count per push (FR-COST-5). */
export async function recordUsage(q: Queryable, bridgeId: string, day: string, d: UsageDelta): Promise<void> {
  await q.query(
    `insert into usage_daily (day, bridge_id, pushes, replies, billed_estimate, relayed_messages)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (day, bridge_id) do update set
       pushes = usage_daily.pushes + excluded.pushes,
       replies = usage_daily.replies + excluded.replies,
       billed_estimate = usage_daily.billed_estimate + excluded.billed_estimate,
       relayed_messages = usage_daily.relayed_messages + excluded.relayed_messages`,
    [day, bridgeId, d.pushes ?? 0, d.replies ?? 0, d.billed ?? 0, d.relayed ?? 0],
  );
}

export interface UsageTotals {
  pushes: number;
  replies: number;
  billed: number;
  relayed: number;
}

/** Month-to-date totals for one bridge, or all bridges when `bridgeId` is null. */
export async function monthToDate(q: Queryable, bridgeId: string | null, day: LocalDay): Promise<UsageTotals> {
  const { rows } = await q.query<{ pushes: number | null; replies: number | null; billed: number | null; relayed: number | null }>(
    `select sum(pushes)::bigint as pushes, sum(replies)::bigint as replies,
            sum(billed_estimate)::bigint as billed, sum(relayed_messages)::bigint as relayed
     from usage_daily where day >= $1::date and day <= $2::date and ($3::uuid is null or bridge_id = $3::uuid)`,
    [day.monthStart, day.day, bridgeId],
  );
  const r = rows[0];
  return { pushes: r?.pushes ?? 0, replies: r?.replies ?? 0, billed: r?.billed ?? 0, relayed: r?.relayed ?? 0 };
}
