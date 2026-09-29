import type { AppContext } from '../app/context.js';
import { META_REFRESH_MS } from './groups.js';
import { claimTasks, enqueueTask } from './tasks.js';
import { processTask } from '../processor/tasks.js';
import type { EventProcessor } from '../processor/processor.js';
import type { Lanes } from '../delivery/lanes.js';
import type { QuotaGuard } from '../cost/quotaGuard.js';
import { runRetentionPurge } from '../retention/purge.js';
import { addMs } from '../util/clock.js';

const TASK_BATCH = 10;
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const METRICS_UPDATE_INTERVAL_MS = 15_000;

export class Scheduler {
  private stopped = false;
  private abort = new AbortController();

  constructor(
    private ctx: AppContext,
    private processor: EventProcessor,
    private lanes: Lanes,
    private quota: QuotaGuard,
  ) {}

  stop(): void {
    this.stopped = true;
    this.abort.abort();
  }

  /** Main worker loop: runs event processing, tasks, delivery lanes and periodic maintenance. */
  async start(): Promise<void> {
    const { ctx } = this;
    ctx.log.info('worker scheduler loop started');

    while (!this.stopped) {
      try {
        let workDone = 0;

        // 1. Process inbound events
        const processed = await this.processor.runBatch();
        workDone += processed;

        // 2. Process ready tasks (media download, image set flushes, metadata)
        const tasks = await claimTasks(ctx.db, ctx.clock.now(), TASK_BATCH);
        for (const task of tasks) {
          await processTask(ctx, task);
        }
        workDone += tasks.length;

        // 3. Process delivery lanes
        const sent = await this.lanes.runDue(ctx.config.WORKER_CONCURRENCY);
        workDone += sent;

        // 4. Periodic maintenance checks
        await this.runPeriodicJobs();

        // If no work was available, sleep briefly before next iteration
        if (workDone === 0) {
          await ctx.clock.sleep(500, this.abort.signal);
        }
      } catch (err) {
        if (this.stopped) break;
        ctx.log.error({ err }, 'error in scheduler loop');
        await ctx.clock.sleep(1000, this.abort.signal);
      }
    }
    ctx.log.info('worker scheduler loop stopped');
  }

  private async runPeriodicJobs(): Promise<void> {
    const { ctx } = this;
    const now = ctx.clock.now();

    // A. Quota polling (every QUOTA_POLL_S)
    if (await this.shouldRun('quota_poll', ctx.config.QUOTA_POLL_S * 1000, now)) {
      try {
        await this.quota.poll();
      } catch (err) {
        ctx.log.warn({ err }, 'scheduled quota poll failed');
      }
    }

    // B. Retention purge (daily)
    if (await this.shouldRun('retention_purge', RETENTION_INTERVAL_MS, now)) {
      try {
        await runRetentionPurge(ctx, now);
      } catch (err) {
        ctx.log.error({ err }, 'scheduled retention purge failed');
      }
    }

    // C. Group metadata refresh (every 6h per group)
    if (await this.shouldRun('group_meta_scan', 60_000, now)) {
      const cutoff = addMs(now, -META_REFRESH_MS);
      const { rows } = await ctx.db.query<{ group_id: string }>(
        `select group_id from member_groups
         where state = 'attached' and (meta_refreshed_at is null or meta_refreshed_at < $1)
         limit 10`,
        [cutoff],
      );
      for (const r of rows) {
        await enqueueTask(ctx.db, 'group_meta', { groupId: r.group_id }, now, `meta:${r.group_id}`);
      }
    }

    // D. Metrics queue depth gauges
    if (await this.shouldRun('metrics_depth', METRICS_UPDATE_INTERVAL_MS, now)) {
      await this.updateMetrics();
    }
  }

  /** Coordinates periodic jobs across multiple processes using scheduler_runs table. */
  private async shouldRun(name: string, intervalMs: number, now: Date): Promise<boolean> {
    const cutoff = addMs(now, -intervalMs);
    const { rowCount } = await this.ctx.db.query(
      `insert into scheduler_runs (name, last_run_at) values ($1, $2)
       on conflict (name) do update set last_run_at = excluded.last_run_at
       where scheduler_runs.last_run_at < $3`,
      [name, now, cutoff],
    );
    return rowCount > 0;
  }

  private async updateMetrics(): Promise<void> {
    const { ctx } = this;
    try {
      const inbound = await ctx.db.query<{ n: number }>(`select count(*) as n from inbound_events where state in ('pending','claimed')`);
      ctx.metrics.queueDepth.set({ queue: 'inbound' }, inbound.rows[0]?.n ?? 0);

      const jobs = await ctx.db.query<{ state: string; n: number }>(`select state, count(*) as n from relay_jobs group by state`);
      for (const j of jobs.rows) {
        ctx.metrics.queueDepth.set({ queue: `jobs_${j.state}` }, j.n);
      }

      const tasks = await ctx.db.query<{ n: number }>(`select count(*) as n from tasks where state in ('pending','running')`);
      ctx.metrics.queueDepth.set({ queue: 'tasks' }, tasks.rows[0]?.n ?? 0);

      if (ctx.tokens) {
        const st = ctx.tokens.status();
        if (st.expiresAt) {
          const sec = Math.max(0, (st.expiresAt.getTime() - ctx.clock.now().getTime()) / 1000);
          ctx.metrics.tokenExpiry.set(sec);
        }
      }
    } catch {
      // Best-effort metric update
    }
  }
}
