import { readFileSync } from 'node:fs';

export interface StickerRange {
  from: number;
  to: number;
}

export interface PackageAllowlist {
  packageId: string;
  stickerIds?: string[];
  ranges?: StickerRange[];
}

// Snapshot of official sendable stickers provided by LINE Messaging API (DOC sticker-list).
export const DEFAULT_STICKER_ALLOWLIST: PackageAllowlist[] = [
  { packageId: '446', ranges: [{ from: 1988, to: 2027 }] },
  { packageId: '789', ranges: [{ from: 10855, to: 10894 }] },
  { packageId: '1070', ranges: [{ from: 17839, to: 17878 }] },
  { packageId: '6136', ranges: [{ from: 10551376, to: 10551415 }] },
  { packageId: '6325', ranges: [{ from: 10979904, to: 10979943 }] },
  { packageId: '6359', ranges: [{ from: 11069838, to: 11069877 }] },
  { packageId: '6362', ranges: [{ from: 11080016, to: 11080055 }] },
  { packageId: '6370', ranges: [{ from: 11100344, to: 11100383 }] },
  { packageId: '6632', ranges: [{ from: 11805544, to: 11805583 }] },
  { packageId: '8515', ranges: [{ from: 16581240, to: 16581279 }] },
  { packageId: '8522', ranges: [{ from: 16581280, to: 16581319 }] },
  { packageId: '8525', ranges: [{ from: 16581320, to: 16581359 }] },
  { packageId: '11537', ranges: [{ from: 52002734, to: 52002773 }] },
  { packageId: '11538', ranges: [{ from: 52002774, to: 52002813 }] },
  { packageId: '11539', ranges: [{ from: 52002814, to: 52002853 }] },
];

export class StickerPolicy {
  private allowed = new Map<string, { ids: Set<string>; ranges: StickerRange[] }>();
  private denied = new Set<string>();

  constructor(allowlist: PackageAllowlist[] = DEFAULT_STICKER_ALLOWLIST) {
    for (const pkg of allowlist) {
      this.allowed.set(pkg.packageId, {
        ids: new Set(pkg.stickerIds ?? []),
        ranges: pkg.ranges ?? [],
      });
    }
  }

  isSendable(packageId: string, stickerId: string): boolean {
    const key = `${packageId}:${stickerId}`;
    if (this.denied.has(key)) return false;
    const pkg = this.allowed.get(packageId);
    if (!pkg) return false;
    if (pkg.ids.has(stickerId)) return true;
    const num = Number(stickerId);
    if (Number.isFinite(num)) {
      for (const r of pkg.ranges) {
        if (num >= r.from && num <= r.to) return true;
      }
    }
    return false;
  }

  deny(packageId: string, stickerId: string): void {
    this.denied.add(`${packageId}:${stickerId}`);
  }
}

export function loadStickerAllowlist(path?: string): StickerPolicy {
  if (!path) return new StickerPolicy();
  const raw = readFileSync(path, 'utf8');
  const data = JSON.parse(raw) as PackageAllowlist[];
  return new StickerPolicy(data);
}
