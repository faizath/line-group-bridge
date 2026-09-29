import { pino, type Logger } from 'pino';

export type { Logger };

/** Structured JSON logger. Secrets and message bodies are redacted (NFR-SEC-2, NFR-OBS-5). */
export function createLogger(level: string, opts: { logMessageText?: boolean } = {}): Logger {
  const paths = [
    'req.headers.authorization',
    'headers.authorization',
    '*.authorization',
    '*.channelAccessToken',
    '*.accessToken',
    '*.access_token',
    '*.channelSecret',
    '*.replyToken',
  ];
  if (!opts.logMessageText) paths.push('*.text', 'text', 'message.text');
  return pino({
    level,
    base: { svc: 'line-group-bridge' },
    redact: { paths, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

/** Operator-facing alert: a log line tagged for alert routing (NFR-OBS-3). */
export function alert(log: Logger, name: string, fields: Record<string, unknown> = {}): void {
  log.warn({ alert: name, ...fields }, `ALERT ${name}`);
}
