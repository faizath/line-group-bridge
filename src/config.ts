import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return def;
      const n = Number(v);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: 'custom', message: `not a number: ${v}` });
        return z.NEVER;
      }
      return n;
    });

const list = z
  .string()
  .optional()
  .transform((v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : v));

export const DELIVERY_MODES = ['immediate', 'batched', 'economy', 'strict_economy'] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];
export const LOCALES = ['en', 'ja', 'th', 'zh-TW'] as const;
export type Locale = (typeof LOCALES)[number];

const schema = z
  .object({
    ROLE: z.enum(['web', 'worker', 'all']).default('all'),
    PORT: int(8080),
    ADMIN_PORT: int(8081),
    HOST: z.string().default('0.0.0.0'),
    ADMIN_HOST: z.string().default('127.0.0.1'),
    LINE_CHANNEL_ID: optionalString,
    LINE_CHANNEL_SECRET: z.string().min(1, 'LINE_CHANNEL_SECRET is required'),
    LINE_ACCESS_TOKEN: optionalString,
    LINE_JWK_PRIVATE_KEY: optionalString,
    LINE_JWK_KID: optionalString,
    LINE_TOKEN_MODE: z.enum(['long_lived', 'v21', 'stateless']).default('long_lived'),
    LINE_BOT_USER_ID: optionalString,
    LINE_API_BASE: z.string().url().default('https://api.line.me'),
    LINE_API_DATA_BASE: z.string().url().default('https://api-data.line.me'),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    MEDIA_BACKEND: z.enum(['s3', 'fs']).default('s3'),
    MEDIA_FS_ROOT: z.string().default('./data/media'),
    S3_ENDPOINT: optionalString,
    S3_REGION: z.string().default('auto'),
    S3_BUCKET: optionalString,
    S3_ACCESS_KEY_ID: optionalString,
    S3_SECRET_ACCESS_KEY: optionalString,
    MEDIA_PUBLIC_BASE_URL: z.string().url('MEDIA_PUBLIC_BASE_URL is required'),
    OPERATOR_USER_IDS: list,
    BRIDGE_CREATE_POLICY: z.enum(['operators', 'anyone', 'allowlist']).default('operators'),
    BRIDGE_CREATE_ALLOWLIST: list,
    BRIDGE_JOIN_REQUIRES_ADMIN: bool(false),
    COMMAND_PREFIX: z.string().default('/bridge'),
    DEFAULT_DELIVERY_MODE: z.enum(DELIVERY_MODES).default('batched'),
    BATCH_WINDOW_MS: int(3000),
    ECONOMY_MAX_HOLD_S: z
      .string()
      .optional()
      .transform((v) => (v === undefined ? 600 : v === '' ? null : Number(v))),
    MAX_GROUPS_PER_BRIDGE: int(10),
    QUOTA_ALERT_PCT: int(80),
    QUOTA_HARD_PCT: int(95),
    QUOTA_TZ: z.string().default('Asia/Tokyo'),
    QUOTA_POLL_S: int(900),
    RATE_LIMIT_RPS: int(1000),
    RETENTION_TEXT_DAYS: int(30),
    RETENTION_MEDIA_DAYS: int(30),
    RETENTION_AV_DAYS: int(7),
    RETENTION_MAP_DAYS: int(90),
    RETENTION_PAYLOAD_DAYS: int(7),
    RETENTION_PROFILE_DAYS: int(180),
    FILE_RELAY_MAX_MB: int(50),
    LOCALE_DEFAULT: z.enum(LOCALES).default('en'),
    PRIVACY_URL: optionalString,
    LOG_LEVEL: z.string().default('info'),
    LOG_MESSAGE_TEXT: bool(false),
    ADMIN_API_TOKENS: list,
    STICKER_ALLOWLIST_PATH: optionalString,
    FFMPEG_PATH: z.string().default('ffmpeg'),
    FLOOD_GROUP_PER_MIN: int(30),
    FLOOD_USER_PER_MIN: int(15),
    WORKER_CONCURRENCY: int(8),
    NOTICE_MEMBER_EVENTS: bool(false),
    FORBIDDEN_NAME_WORDS: z
      .string()
      .optional()
      .transform((v) => (v ?? 'LINE').split(',').map((s) => s.trim()).filter(Boolean)),
  })
  .superRefine((c, ctx) => {
    if (c.LINE_TOKEN_MODE === 'long_lived' && !c.LINE_ACCESS_TOKEN) {
      ctx.addIssue({ code: 'custom', path: ['LINE_ACCESS_TOKEN'], message: 'required when LINE_TOKEN_MODE=long_lived' });
    }
    if (c.LINE_TOKEN_MODE === 'v21' && (!c.LINE_JWK_PRIVATE_KEY || !c.LINE_JWK_KID || !c.LINE_CHANNEL_ID)) {
      ctx.addIssue({
        code: 'custom',
        path: ['LINE_JWK_PRIVATE_KEY'],
        message: 'LINE_JWK_PRIVATE_KEY, LINE_JWK_KID and LINE_CHANNEL_ID are required when LINE_TOKEN_MODE=v21',
      });
    }
    if (c.LINE_TOKEN_MODE === 'stateless' && !c.LINE_CHANNEL_ID) {
      ctx.addIssue({ code: 'custom', path: ['LINE_CHANNEL_ID'], message: 'required when LINE_TOKEN_MODE=stateless' });
    }
    if (c.MEDIA_BACKEND === 's3' && !c.S3_BUCKET) {
      ctx.addIssue({ code: 'custom', path: ['S3_BUCKET'], message: 'required when MEDIA_BACKEND=s3' });
    }
    if (c.BATCH_WINDOW_MS < 1000 || c.BATCH_WINDOW_MS > 60_000) {
      ctx.addIssue({ code: 'custom', path: ['BATCH_WINDOW_MS'], message: 'must be within 1000–60000' });
    }
  });

export type Config = z.output<typeof schema> & { channelId: string };

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  const c = parsed.data;
  return {
    ...c,
    MEDIA_PUBLIC_BASE_URL: c.MEDIA_PUBLIC_BASE_URL.replace(/\/+$/, ''),
    channelId: c.LINE_CHANNEL_ID ?? 'default',
  };
}
