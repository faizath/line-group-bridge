// Forward-only, versioned schema migrations (NFR-MAINT-3). Never edit an applied
// migration; append a new one instead.

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `
create table bridges (
  id               uuid primary key,
  channel_id       text not null,
  name             text not null,
  delivery_mode    text not null check (delivery_mode in ('immediate','batched','economy','strict_economy')),
  batch_window_ms  int  not null default 3000,
  max_hold_s       int,
  origin_tag_style text not null default 'name_suffix' check (origin_tag_style in ('none','name_suffix','text_prefix')),
  notification_disabled bool not null default false,
  notices_join     bool not null default true,
  notices_leave    bool not null default true,
  notices_unsend   bool not null default true,
  locale           text not null default 'en',
  monthly_budget   bigint,
  default_icon_url text,
  forced_mode_reason text,
  mode_before_force  text,
  status           text not null default 'active' check (status in ('active','disabled')),
  created_by       text,
  created_at       timestamptz not null default now()
);

create table member_groups (
  group_id         text primary key,
  channel_id       text not null,
  bridge_id        uuid references bridges(id) on delete set null,
  state            text not null check (state in ('unattached','attached','detached','bot_removed')),
  relay_in         bool not null default true,
  relay_out        bool not null default true,
  short_tag        text,
  name             text,
  picture_url      text,
  member_count     int,
  meta_refreshed_at timestamptz,
  count_refresh_due_at timestamptz,
  joined_at        timestamptz,
  attached_at      timestamptz,
  created_at       timestamptz not null default now()
);
create index member_groups_bridge_attached on member_groups (bridge_id) where state = 'attached';
create unique index member_groups_bridge_tag on member_groups (bridge_id, short_tag) where bridge_id is not null;

create table bridge_admins (
  bridge_id uuid not null references bridges(id) on delete cascade,
  user_id   text not null,
  role      text not null check (role in ('owner','admin','moderator')),
  created_at timestamptz not null default now(),
  primary key (bridge_id, user_id)
);

create table link_codes (
  code        text primary key,
  bridge_id   uuid not null references bridges(id) on delete cascade,
  created_by  text not null,
  expires_at  timestamptz not null,
  max_uses    int not null default 1,
  uses        int not null default 0,
  created_at  timestamptz not null default now()
);

create table line_users (
  user_id          text primary key,
  display_name     text,
  picture_url      text,
  icon_object_key  text,
  icon_hash        text,
  profile_fetched_at timestamptz,
  last_seen_at     timestamptz,
  opted_out        bool not null default false,
  created_at       timestamptz not null default now()
);

create table bridge_mutes (
  bridge_id  uuid not null references bridges(id) on delete cascade,
  user_id    text not null,
  muted_by   text,
  created_at timestamptz not null default now(),
  primary key (bridge_id, user_id)
);

create table group_memberships (
  group_id   text not null references member_groups(group_id) on delete cascade,
  user_id    text not null references line_users(user_id) on delete cascade,
  last_seen_at timestamptz not null,
  left_at    timestamptz,
  primary key (group_id, user_id)
);

create table inbound_events (
  webhook_event_id text primary key,
  channel_id       text not null,
  type             text not null,
  group_id         text,
  event_ts         timestamptz not null,
  received_at      timestamptz not null,
  is_redelivery    bool not null,
  payload          jsonb not null,
  state            text not null default 'pending' check (state in ('pending','claimed','done','parked','failed')),
  lease_until      timestamptz,
  lease_owner      text,
  attempts         int not null default 0,
  parked_until     timestamptz,
  error            text,
  processed_at     timestamptz
);
create index inbound_events_ready on inbound_events (state, event_ts) where state in ('pending','claimed','parked');

create table reply_tokens (
  token        text primary key,
  group_id     text not null,
  source_event text not null,
  issued_at    timestamptz not null,
  claimed_by   text,
  claimed_at   timestamptz
);
create index reply_tokens_free on reply_tokens (group_id, issued_at) where claimed_at is null;

create table origin_messages (
  message_id      text primary key,
  bridge_id       uuid not null references bridges(id) on delete cascade,
  group_id        text not null,
  user_id         text,
  type            text not null,
  event_ts        timestamptz not null,
  quote_token     text,
  quoted_message_id text,
  text            text,
  meta            jsonb,
  relayed         bool not null default true,
  media_state     text not null default 'none' check (media_state in ('none','pending','ready','failed')),
  image_set_id    text,
  edited_at       timestamptz,
  unsent_at       timestamptz,
  purged_at       timestamptz,
  created_at      timestamptz not null default now()
);
create index origin_messages_bridge_ts on origin_messages (bridge_id, event_ts);
create index origin_messages_group_ts on origin_messages (group_id, event_ts);
create index origin_messages_user on origin_messages (user_id);
create index origin_messages_image_set on origin_messages (image_set_id) where image_set_id is not null;

create table outbound_requests (
  id              uuid primary key,
  target_group_id text not null,
  bridge_id       uuid,
  method          text not null check (method in ('push','reply')),
  retry_key       uuid,
  reply_token     text,
  body            jsonb not null,
  parts           jsonb not null,
  state           text not null check (state in ('pending','sending','done','failed','dead')),
  attempts        int not null default 0,
  fallback_step   int not null default 0,
  first_attempt_at timestamptz,
  next_attempt_at timestamptz not null,
  lease_until     timestamptz,
  billed_estimate int not null default 0,
  last_error      text,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz
);
create index outbound_requests_open on outbound_requests (target_group_id, next_attempt_at) where state in ('pending','sending');

create table relay_jobs (
  id              uuid primary key,
  bridge_id       uuid references bridges(id) on delete cascade,
  origin_message_id text references origin_messages(message_id) on delete set null,
  origin_group_id text,
  target_group_id text not null references member_groups(group_id) on delete cascade,
  kind            text not null check (kind in ('relay','edit','unsend_notice','notice')),
  state           text not null check (state in ('waiting','queued','held','sending','delivered','cancelled','dead')),
  order_ts        timestamptz not null,
  order_idx       int not null default 0,
  ready_at        timestamptz not null,
  notice          jsonb,
  request_id      uuid references outbound_requests(id) on delete set null,
  retry_key       uuid,
  retry_key_first_used_at timestamptz,
  delivered_via   text,
  delivered_at    timestamptz,
  attempts        int not null default 0,
  last_error      text,
  created_at      timestamptz not null default now(),
  unique (origin_message_id, target_group_id, kind)
);
create index relay_jobs_lane on relay_jobs (target_group_id, state, order_ts, order_idx);
create index relay_jobs_origin on relay_jobs (origin_message_id);
create index relay_jobs_request on relay_jobs (request_id);

create table relay_attempts (
  id              bigserial primary key,
  request_id      uuid,
  job_ids         uuid[] not null,
  target_group_id text not null,
  method          text not null,
  retry_key       uuid,
  request_id_line text,
  accepted_request_id text,
  http_status     int,
  error_message   text,
  billed_estimate int not null default 0,
  started_at      timestamptz not null,
  finished_at     timestamptz
);
create index relay_attempts_started on relay_attempts (started_at);

create table relay_copies (
  target_group_id  text not null,
  sent_message_id  text not null,
  origin_message_id text not null references origin_messages(message_id) on delete cascade,
  part_index       int not null default 0,
  quote_token      text,
  created_at       timestamptz not null default now(),
  primary key (target_group_id, sent_message_id, origin_message_id)
);
create index relay_copies_origin on relay_copies (origin_message_id, target_group_id, part_index);

create table media_objects (
  id              uuid primary key,
  origin_message_id text references origin_messages(message_id) on delete cascade,
  role            text not null check (role in ('original','preview','avatar','file','default_icon')),
  object_key      text not null unique,
  content_type    text not null,
  bytes           bigint not null,
  width int, height int, duration_ms int,
  sha256          text,
  expires_at      timestamptz,
  created_at      timestamptz not null default now()
);
create index media_objects_origin on media_objects (origin_message_id);
create index media_objects_expiry on media_objects (expires_at);
create index media_objects_sha on media_objects (sha256, role);

create table usage_daily (
  day        date not null,
  bridge_id  uuid not null,
  pushes     int not null default 0,
  replies    int not null default 0,
  billed_estimate bigint not null default 0,
  relayed_messages int not null default 0,
  primary key (day, bridge_id)
);

create table quota_snapshots (
  taken_at   timestamptz primary key,
  quota_type text,
  quota_value bigint,
  total_usage bigint
);

create table tasks (
  id          uuid primary key,
  kind        text not null,
  dedupe_key  text unique,
  payload     jsonb not null default '{}'::jsonb,
  run_at      timestamptz not null,
  state       text not null default 'pending' check (state in ('pending','running','done','failed')),
  lease_until timestamptz,
  attempts    int not null default 0,
  last_error  text,
  created_at  timestamptz not null default now()
);
create index tasks_ready on tasks (state, run_at) where state in ('pending','running');

create table lanes (
  group_id    text primary key,
  lease_owner text,
  lease_until timestamptz
);

create table scheduler_runs (
  name        text primary key,
  last_run_at timestamptz not null
);

create table system_state (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

create table sticker_denylist (
  package_id text not null,
  sticker_id text not null,
  created_at timestamptz not null default now(),
  primary key (package_id, sticker_id)
);

create table command_log (
  id         bigserial primary key,
  group_id   text,
  user_id    text,
  command    text not null,
  outcome    text not null,
  created_at timestamptz not null default now()
);
create index command_log_created on command_log (created_at);

create table rate_buckets (
  name       text primary key,
  tokens     double precision not null,
  updated_at timestamptz not null
);
`,
  },
];
