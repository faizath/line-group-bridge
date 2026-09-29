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
} as const;

export type MessageKey = keyof typeof en;
export type Catalog = Record<MessageKey, string>;
