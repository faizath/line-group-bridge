import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** Prometheus metrics (NFR-OBS-2). One instance per process; exposed on the admin port. */
export class Metrics {
  readonly registry = new Registry();

  readonly webhookRequests = new Counter({
    name: 'lgb_webhook_requests_total',
    help: 'Webhook requests by HTTP status',
    labelNames: ['status'],
    registers: [this.registry],
  });
  readonly webhookLatency = new Histogram({
    name: 'lgb_webhook_duration_seconds',
    help: 'Webhook handler latency',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
    registers: [this.registry],
  });
  readonly webhookEvents = new Counter({
    name: 'lgb_webhook_events_total',
    help: 'Webhook events by outcome (stored, duplicate, stale)',
    labelNames: ['outcome'],
    registers: [this.registry],
  });
  readonly lineApiCalls = new Counter({
    name: 'lgb_line_api_calls_total',
    help: 'LINE API responses by endpoint and status',
    labelNames: ['endpoint', 'status'],
    registers: [this.registry],
  });
  readonly lineApiLatency = new Histogram({
    name: 'lgb_line_api_duration_seconds',
    help: 'LINE API call latency by endpoint',
    labelNames: ['endpoint'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 15],
    registers: [this.registry],
  });
  readonly relayLatency = new Histogram({
    name: 'lgb_relay_latency_seconds',
    help: 'Origin event timestamp to relay accepted, by message type, delivery mode and method',
    labelNames: ['type', 'mode', 'method'],
    buckets: [0.5, 1, 1.5, 2, 3, 5, 10, 20, 60, 300, 1800],
    registers: [this.registry],
  });
  readonly relayRequests = new Counter({
    name: 'lgb_relay_requests_total',
    help: 'Relay requests sent, by method (push/reply) and outcome',
    labelNames: ['method', 'outcome'],
    registers: [this.registry],
  });
  readonly retries = new Counter({
    name: 'lgb_relay_retries_total',
    help: 'Relay retries by reason',
    labelNames: ['reason'],
    registers: [this.registry],
  });
  readonly deadLetters = new Counter({
    name: 'lgb_dead_letters_total',
    help: 'Relay jobs moved to the dead-letter state',
    registers: [this.registry],
  });
  readonly billedEstimate = new Counter({
    name: 'lgb_billed_messages_estimate_total',
    help: 'Estimated billed messages (sum of target member counts over pushes)',
    labelNames: ['bridge'],
    registers: [this.registry],
  });
  readonly replyFlush = new Counter({
    name: 'lgb_reply_token_flush_total',
    help: 'Reply-token flush attempts by outcome (hit = free delivery, miss = nothing to flush, failed)',
    labelNames: ['outcome'],
    registers: [this.registry],
  });
  readonly quotaLimit = new Gauge({
    name: 'lgb_quota_limit',
    help: 'LINE monthly message quota (target limit); -1 when unlimited',
    registers: [this.registry],
  });
  readonly quotaUsage = new Gauge({
    name: 'lgb_quota_consumption',
    help: 'LINE monthly message consumption (approximate)',
    registers: [this.registry],
  });
  readonly queueDepth = new Gauge({
    name: 'lgb_queue_depth',
    help: 'Pending work by queue (inbound events, relay jobs by state, tasks)',
    labelNames: ['queue'],
    registers: [this.registry],
  });
  readonly tokenExpiry = new Gauge({
    name: 'lgb_access_token_expiry_seconds',
    help: 'Seconds until the channel access token expires (absent for long-lived tokens)',
    registers: [this.registry],
  });

  constructor(opts: { defaultMetrics?: boolean } = {}) {
    if (opts.defaultMetrics) collectDefaultMetrics({ register: this.registry });
  }
}
