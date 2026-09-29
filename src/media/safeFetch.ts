import type { LookupAddress } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP, isIPv4 } from 'node:net';

const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type SafeFetchFailure = 'blocked' | 'too_large' | 'timeout' | 'http_status' | 'too_many_redirects' | 'network';

export class SafeFetchError extends Error {
  constructor(
    message: string,
    readonly reason: SafeFetchFailure,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

export interface SafeFetchOptions {
  maxBytes: number;
  /** Deadline for the whole fetch, redirects included. */
  timeoutMs: number;
  /** Permit plain http (tests only). */
  allowHttp?: boolean;
  /** Permit 127.0.0.1 and ::1 loopback (tests only). */
  allowLoopback?: boolean;
  /** Replaces the public-address check (tests only; lets a loopback test server stand in for a public host). */
  isAllowedAddress?: (ip: string) => boolean;
}

// [network, prefix length] pairs of IPv4 ranges that must never be reached from here:
// "this network", RFC 1918, CGNAT, loopback, link-local (incl. cloud metadata), IETF protocol
// assignments, documentation, 6to4 relay, benchmarking, multicast, reserved and broadcast.
const BLOCKED_V4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const BLOCKED_V4_INT = BLOCKED_V4.map(([net, bits]) => {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return { base: (v4ToInt(net) & mask) >>> 0, mask };
});

function isPublicV4Int(n: number): boolean {
  return !BLOCKED_V4_INT.some(({ base, mask }) => ((n & mask) >>> 0) === base);
}

/** Eight 16-bit groups of an IPv6 address, via the WHATWG URL parser's canonical (compressed, hex-only) form. */
function ipv6Groups(ip: string): number[] | null {
  let canonical: string;
  try {
    canonical = new URL(`http://[${ip.split('%')[0]}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const [head = '', tail] = canonical.split('::');
  const headParts = head === '' ? [] : head.split(':');
  const tailParts = tail === undefined || tail === '' ? [] : tail.split(':');
  const fill = tail === undefined ? 0 : 8 - headParts.length - tailParts.length;
  const groups = [...headParts, ...Array<string>(fill).fill('0'), ...tailParts].map((g) => parseInt(g, 16));
  return groups.length === 8 ? groups : null;
}

/**
 * True only for globally routable unicast addresses. Private, loopback, link-local,
 * CGNAT, unique-local, multicast, documentation and metadata addresses are refused,
 * including IPv4 addresses embedded in IPv6 (mapped, compatible, NAT64, 6to4).
 */
export function isPublicAddress(ip: string): boolean {
  if (isIPv4(ip)) return isPublicV4Int(v4ToInt(ip));
  if (isIP(ip) !== 6) return false;
  const g = ipv6Groups(ip);
  if (!g) return false;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const embeddedV4 = ((g6 << 16) | g7) >>> 0;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    // ::ffff:a.b.c.d (mapped) reaches the IPv4 host; ::, ::1 and ::a.b.c.d (deprecated compatible) are never public.
    return g5 === 0xffff && isPublicV4Int(embeddedV4);
  }
  // NAT64 well-known prefix 64:ff9b::/96 translates to the embedded IPv4 address.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPublicV4Int(embeddedV4);
  // 6to4 (2002::/16) tunnels to the IPv4 address in groups 1–2.
  if (g0 === 0x2002) return isPublicV4Int(((g1 << 16) | g2) >>> 0);
  // Only global unicast (2000::/3); this excludes fc00::/7, fe80::/10, ff00::/8, 64:ff9b:1::/48, 100::/64.
  if ((g0 & 0xe000) !== 0x2000) return false;
  if (g0 === 0x2001 && g1 === 0) return false; // Teredo (embedded IPv4 is obfuscated)
  if (g0 === 0x2001 && g1 === 0xdb8) return false; // documentation
  if (g0 === 0x2001 && g1 === 0x2 && g2 === 0) return false; // benchmarking
  if (g0 === 0x2001 && (g1 & 0xfff0) === 0x10) return false; // ORCHID
  if (g0 === 0x3fff && g1 <= 0x0fff) return false; // documentation 3fff::/20
  return true;
}

interface Vetted {
  address: string;
  family: 4 | 6;
}

async function resolveVetted(url: URL, opts: SafeFetchOptions, signal: AbortSignal): Promise<Vetted> {
  if (url.protocol !== 'https:' && !(opts.allowHttp && url.protocol === 'http:')) {
    throw new SafeFetchError(`scheme not allowed: ${url.protocol}`, 'blocked');
  }
  const allowed =
    opts.isAllowedAddress ??
    ((ip: string) => (opts.allowLoopback && (ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.'))) || isPublicAddress(ip));
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  const literal = isIP(host);
  let candidates: LookupAddress[];
  if (literal) {
    candidates = [{ address: host, family: literal }];
  } else {
    // Aborting only rejects `aborted` while the lookup is pending, so no rejection goes unhandled.
    let onAbort = (): void => undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new SafeFetchError('timeout', 'timeout'));
    });
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      candidates = await Promise.race([dnsLookup(host, { all: true, verbatim: true }), aborted]);
    } catch (err) {
      if (err instanceof SafeFetchError) throw err;
      throw new SafeFetchError(`cannot resolve ${host}: ${err instanceof Error ? err.message : String(err)}`, 'network');
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
  // Refuse the host if any record is non-public: an attacker controlling DNS could otherwise
  // mix a public and an internal address and hope the internal one gets used.
  const first = candidates[0];
  if (!first || candidates.some((c) => !allowed(c.address))) {
    throw new SafeFetchError(`address not allowed for ${host}`, 'blocked');
  }
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

type Hop = { kind: 'redirect'; location: string } | { kind: 'body'; contentType: string; data: Buffer };

function requestOnce(url: URL, target: Vetted, opts: SafeFetchOptions, signal: AbortSignal): Promise<Hop> {
  // Connect to the vetted address no matter what the resolver would say now (DNS rebinding).
  const lookup = (
    _hostname: string,
    lookupOpts: { all?: boolean },
    callback: (err: null, addressOrList: string | LookupAddress[], family?: number) => void,
  ) => {
    if (lookupOpts?.all) {
      callback(null, [target]);
    } else {
      callback(null, target.address, target.family);
    }
  };
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  const requestOptions: https.RequestOptions = {
    hostname,
    port: url.port === '' ? undefined : Number(url.port),
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    headers: { 'user-agent': 'line-group-bridge', accept: '*/*' },
    agent: false,
    lookup,
    signal,
  };
  if (!isIP(hostname)) requestOptions.servername = hostname;
  const client = url.protocol === 'https:' ? https : http;

  return new Promise<Hop>((resolvePromise, reject) => {
    const req = client.request(requestOptions, (res) => {
      const status = res.statusCode ?? 0;
      if (REDIRECT_STATUSES.has(status)) {
        res.resume();
        const location = res.headers.location;
        if (!location) {
          reject(new SafeFetchError(`redirect without location (${status})`, 'http_status', status));
          return;
        }
        resolvePromise({ kind: 'redirect', location });
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        reject(new SafeFetchError(`unexpected status ${status}`, 'http_status', status));
        return;
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > opts.maxBytes) {
        req.destroy();
        reject(new SafeFetchError(`content-length ${declared} exceeds ${opts.maxBytes}`, 'too_large'));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > opts.maxBytes) {
          req.destroy();
          reject(new SafeFetchError(`body exceeds ${opts.maxBytes} bytes`, 'too_large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const contentType = (res.headers['content-type'] ?? 'application/octet-stream').split(';')[0]!.trim().toLowerCase();
        resolvePromise({ kind: 'body', contentType, data: Buffer.concat(chunks, total) });
      });
      res.on('error', (err) => reject(new SafeFetchError(err.message, 'network')));
    });
    req.on('error', (err) => reject(new SafeFetchError(err.message, 'network')));
    req.end();
  });
}

/**
 * Fetches an untrusted URL without letting it reach internal services: every hop's host is
 * resolved and vetted first, the connection is pinned to the vetted address, redirects are
 * re-vetted (at most 3), and size and total time are capped.
 */
export async function safeFetch(
  url: string,
  opts: Partial<SafeFetchOptions> = {},
): Promise<{ contentType: string; data: Buffer }> {
  const fullOpts: SafeFetchOptions = {
    maxBytes: opts.maxBytes ?? 50 * 1024 * 1024,
    timeoutMs: opts.timeoutMs ?? 15000,
    allowHttp: opts.allowHttp,
    allowLoopback: opts.allowLoopback,
    isAllowedAddress: opts.isAllowedAddress,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), fullOpts.timeoutMs);
  try {
    let current: URL;
    try {
      current = new URL(url);
    } catch {
      throw new SafeFetchError('invalid URL', 'blocked');
    }
    for (let redirects = 0; ; redirects++) {
      const target = await resolveVetted(current, fullOpts, controller.signal);
      const hop = await requestOnce(current, target, fullOpts, controller.signal);
      if (hop.kind === 'body') return { contentType: hop.contentType, data: hop.data };
      if (redirects >= MAX_REDIRECTS) throw new SafeFetchError('too many redirects', 'too_many_redirects');
      try {
        current = new URL(hop.location, current);
      } catch {
        throw new SafeFetchError('invalid redirect location', 'blocked');
      }
    }
  } catch (err) {
    if (controller.signal.aborted) throw new SafeFetchError(`timed out after ${fullOpts.timeoutMs} ms`, 'timeout');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
