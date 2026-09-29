// English source catalog. Other locales must provide every key (type-checked).
// `{name}` placeholders are substituted by `t()`.

export const en = {
  // Attribution & translation
  line_user: 'LINE user',
  member: 'Member',
  edited: '(edited)',
  edited_prefix: '✏️ (edited) {author}:',
  unsent_by: 'A message from {author} was unsent.',
  location: 'Location',
  sticker: '[sticker]',
  snippet_photo: '[photo]',
  snippet_video: '[video]',
  snippet_audio: '[audio]',
  snippet_file: '[file]',
  snippet_location: '[location]',
  snippet_sticker: '[sticker]',
  snippet_message: '[message]',
  replying_to: '↩ {author}: {snippet}',
  photo_unavailable: '[photo unavailable]',
  video_unavailable: '[video unavailable]',
  audio_unavailable: '[audio unavailable]',
  video_link: '🎬 {author} sent a video: {url}',
  audio_link: '🔊 {author} sent a voice message: {url}',
  file_link: '📎 {name} ({size})\n{url}',
  file_not_relayed: '📎 {name} ({size}) — not relayed',
  more_photos: '📷 {count} more photos from {author}',
  more_messages: '…and {count} more messages',

  // Commands & administration
  cmd_no_user: 'Commands require LINE profile consent so your identity can be checked.',
  cmd_not_bridged: 'This group is not attached to any bridge. Use {p} create <name> to start a new bridge, or {p} join <code> to join an existing one.',
  cmd_unknown: 'Unknown command. Use {p} help to see available commands.',
  cmd_denied: 'You are not authorized to use this command.',
  cmd_usage: 'Usage: {usage}',

  create_exists: 'This group is already attached to bridge «{bridge}». Use {p} leave first to detach.',
  create_policy: 'Only designated operators may create new bridges on this channel.',
  create_ok: 'Bridge «{bridge}» created! This group is attached as group {tag}.\nOne-time link code: {code} (valid {ttl}h, {uses} use).\nInvite the bot into another group and type {p} join {code} to connect them.',

  code_ok: 'New link code for this bridge: {code} (valid {ttl}h, {uses} use).\nInvite the bot into another group and type {p} join {code} to attach it.',
  join_already: 'This group is already attached to bridge «{bridge}». Use {p} leave first if you wish to switch bridges.',
  join_invalid: 'Invalid or expired link code. Ask a bridge admin for a new code.',
  join_full: 'Bridge «{bridge}» has reached the maximum of {max} groups.',
  join_ok: 'Joined bridge «{bridge}» as group {tag}!\nConnected groups: {groups}',
  privacy_line: 'Privacy policy: {url}',

  leave_ok: 'This group was detached from bridge «{bridge}». Relays to and from this group have stopped.',
  kick_ok: 'The bot has detached and is leaving this group. Goodbye!',
  rename_ok: 'Bridge renamed to «{bridge}».',
  tag_ok: "This group's tag was updated to [{tag}].",
  tag_invalid: 'Tag must be 1–3 letters/numbers and not already used by another group in this bridge.',

  mode_immediate_warning: '⚠️ Immediate mode pushes every message individually. For this bridge size, projected cost is approximately {estimate} messages/month.\nTo confirm, type: {p} mode immediate confirm',
  mode_ok: 'Delivery mode updated to {mode}.',
  mode_immediate: 'immediate (push ASAP)',
  mode_batched: 'batched (coalesced pushes)',
  mode_economy: 'economy (free reply flushes)',
  mode_strict_economy: 'strict economy (free reply flushes only)',

  window_ok: 'Batch window set to {seconds} seconds.',
  hold_ok: 'Economy max-hold set to {minutes} minutes.',
  hold_off: 'Economy max-hold disabled (strict economy: only free reply flushes).',

  pause_ok: 'Relays {direction} this group have been paused.',
  resume_ok: 'Relays for this group have been resumed.',
  pause_both: 'to and from',
  pause_in: 'into',
  pause_out: 'from',

  target_no_consent: 'The specified user has not consented to profile access, so their user ID is unknown.',
  mute_need_target: 'Specify a user with @mention or by replying to their message.',
  mute_ok: '{user} has been muted bridge-wide.',
  unmute_ok: '{user} has been unmuted.',

  role_admin: 'Admin',
  role_moderator: 'Moderator',
  role_owner_protected: "The bridge owner's role cannot be changed.",
  role_added: '{user} was added as {role}.',
  role_removed: '{user} was removed from {role}.',

  silent_on: 'Relay notifications disabled (silent relays).',
  silent_off: 'Relay notifications enabled.',

  notices_ok: '{kind} notices are now {state}.',
  state_on: 'ON',
  state_off: 'OFF',

  locale_ok: 'Bridge language set to {locale}.',
  budget_ok: 'Monthly budget set to {budget} messages.',
  budget_off: 'Monthly budget disabled.',
  style_ok: 'Origin tag style set to {style}.',

  optout_ok: 'You have opted out of cross-group relaying. Your messages will not be forwarded to other groups.\nType {p} optin to resume.',
  optin_ok: 'You have opted in to cross-group relaying. Your messages will now be forwarded to other groups.',

  help_member: 'Commands:\n{p} status — show bridge info and groups\n{p} optout / {p} optin — toggle forwarding of your messages\n{p} help — show this help',
  help_moderator: '\nModerator commands:\n{p} pause [in|out|both] / {p} resume — pause group relays\n{p} mute @user / {p} unmute @user — mute a member',
  help_admin: '\nAdmin commands:\n{p} code [uses] [ttl] — issue new link code\n{p} leave / {p} kick — detach or remove bot\n{p} mode <immediate|batched|economy|strict> — delivery mode\n{p} window <sec> / {p} hold <min|off> — timing tuning\n{p} rename <name> / {p} tag <X> — labels\n{p} admin <add|remove> @user — manage admins\n{p} mod <add|remove> @user — manage moderators\n{p} silent <on|off> — mute push notifications\n{p} notices <join|leave|unsend> <on|off> — toggle notices\n{p} locale <en|ja|th|zh-TW> — language\n{p} budget <messages|off> — monthly cap\n{p} style <none|suffix|prefix> — author tag style',

  status_header: 'Bridge: «{bridge}» ({mode}){forced}',
  status_forced: ' [FORCED: {reason}]',
  status_group: '• [{tag}] {name} ({members} members){paused}',
  status_paused: ' [{direction} paused]',
  status_usage: 'Month-to-date: ~{billed} billed messages ({pushes} pushes, {replies} replies)',
  status_budget: 'Monthly budget: {budget} messages',
  status_quota: 'LINE quota: {used} / {limit} (projected: ~{projected})',
  status_quota_unlimited: 'LINE quota: {used} used (unlimited)',
  status_warning: '⚠️ Projected usage exceeds {pct}% of plan limit!',
  status_quota_stopped: '🛑 Pushes currently stopped (monthly limit reached; free replies only)',

  notice_group_joined: 'Group «{group}» joined the bridge.',
  notice_group_left: 'Group «{group}» left the bridge.',
  notice_budget_exhausted: 'Notice: Monthly message budget reached. Switched to strict economy (free reply flushes only).',
  notice_quota_strict: 'Notice: Account monthly quota limit reached. Switched to strict economy (free reply flushes only).',
  onboarding: 'Hello! I am {name}. I connect several LINE groups so they can chat as one community.\nMessages here will be forwarded to connected groups with your display name and avatar.\nTo connect this group to others, type {p} create <name> or {p} join <code>.\nTo opt out of forwarding, type {p} optout.',
} as const;

export type MessageKey = keyof typeof en;
export type Catalog = Record<MessageKey, string>;
