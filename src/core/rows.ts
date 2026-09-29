import type { DeliveryMode } from '../config.js';
import type { OriginMeta } from '../line/types.js';
import type { OriginTagStyle } from '../translate/types.js';

export interface BridgeRow {
  id: string;
  channel_id: string;
  name: string;
  delivery_mode: DeliveryMode;
  batch_window_ms: number;
  max_hold_s: number | null;
  origin_tag_style: OriginTagStyle;
  notification_disabled: boolean;
  notices_join: boolean;
  notices_leave: boolean;
  notices_unsend: boolean;
  locale: string;
  monthly_budget: number | null;
  default_icon_url: string | null;
  forced_mode_reason: string | null;
  mode_before_force: DeliveryMode | null;
  status: 'active' | 'disabled';
  created_by: string | null;
  created_at: Date;
}

export type GroupState = 'unattached' | 'attached' | 'detached' | 'bot_removed';

export interface GroupRow {
  group_id: string;
  channel_id: string;
  bridge_id: string | null;
  state: GroupState;
  relay_in: boolean;
  relay_out: boolean;
  short_tag: string | null;
  name: string | null;
  picture_url: string | null;
  member_count: number | null;
  meta_refreshed_at: Date | null;
  joined_at: Date | null;
  attached_at: Date | null;
}

export interface OriginRow {
  message_id: string;
  bridge_id: string;
  group_id: string;
  user_id: string | null;
  type: string;
  event_ts: Date;
  quote_token: string | null;
  quoted_message_id: string | null;
  text: string | null;
  meta: OriginMeta | null;
  relayed: boolean;
  media_state: 'none' | 'pending' | 'ready' | 'failed';
  image_set_id: string | null;
  edit_count: number;
  edited_at: Date | null;
  unsent_at: Date | null;
  purged_at: Date | null;
}

export type JobKind = 'relay' | 'edit' | 'unsend_notice' | 'notice';
export type JobState = 'waiting' | 'queued' | 'held' | 'sending' | 'delivered' | 'cancelled' | 'dead';

export interface JobRow {
  id: string;
  bridge_id: string | null;
  origin_message_id: string | null;
  origin_group_id: string | null;
  target_group_id: string;
  kind: JobKind;
  state: JobState;
  order_ts: Date;
  fallback_step: number;
  order_idx: number;
  ready_at: Date;
  notice: NoticePayload | null;
  request_id: string | null;
  seq: number;
  created_at: Date;
}

/** Bot-authored notice content: an i18n key with variables, rendered in the bridge locale at send time. */
export interface NoticePayload {
  key: string;
  vars?: Record<string, string | number>;
}

export interface LineUserRow {
  user_id: string;
  display_name: string | null;
  picture_url: string | null;
  icon_object_key: string | null;
  icon_hash: string | null;
  profile_fetched_at: Date | null;
  last_seen_at: Date | null;
  opted_out: boolean;
}

export type Role = 'owner' | 'admin' | 'moderator';
