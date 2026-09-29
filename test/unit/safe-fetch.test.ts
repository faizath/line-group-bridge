import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPublicAddress, safeFetch, SafeFetchError } from '../../src/media/safeFetch.js';

describe('safeFetch and IP classification', () => {
  describe('isPublicAddress', () => {
    it('rejects loopback and private IPv4 ranges', () => {
      expect(isPublicAddress('127.0.0.1')).toBe(false);
      expect(isPublicAddress('127.1.2.3')).toBe(false);
      expect(isPublicAddress('10.0.0.1')).toBe(false);
      expect(isPublicAddress('10.254.254.254')).toBe(false);
      expect(isPublicAddress('172.16.0.1')).toBe(false);
      expect(isPublicAddress('172.31.255.255')).toBe(false);
      expect(isPublicAddress('192.168.1.1')).toBe(false);
      expect(isPublicAddress('169.254.169.254')).toBe(false); // cloud metadata
      expect(isPublicAddress('100.64.0.1')).toBe(false); // CGNAT
      expect(isPublicAddress('0.0.0.0')).toBe(false);
    });

    it('rejects loopback, link-local and unique-local IPv6 ranges', () => {
      expect(isPublicAddress('::1')).toBe(false);
      expect(isPublicAddress('fe80::1')).toBe(false); // link-local
      expect(isPublicAddress('fc00::1')).toBe(false); // ULA
      expect(isPublicAddress('fd12:3456:789a::1')).toBe(false); // ULA
      expect(isPublicAddress('::ffff:10.0.0.1')).toBe(false); // IPv4-mapped private
      expect(isPublicAddress('::ffff:127.0.0.1')).toBe(false); // IPv4-mapped loopback
    });

    it('accepts public IPv4 and IPv6 addresses', () => {
      expect(isPublicAddress('8.8.8.8')).toBe(true);
      expect(isPublicAddress('1.1.1.1')).toBe(true);
      expect(isPublicAddress('93.184.216.34')).toBe(true);
      expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
      expect(isPublicAddress('2001:4860:4860::8888')).toBe(true);
    });
  });

  describe('safeFetch execution', () => {
    let server: http.Server;
    let serverPort: number;

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        if (req.url === '/ok') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('hello safe world');
        } else if (req.url === '/redirect-ok') {
          res.writeHead(302, { Location: `http://127.0.0.1:${serverPort}/ok` });
          res.end();
        } else if (req.url === '/big') {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(Buffer.alloc(1000));
        } else {
          res.writeHead(404);
          res.end('not found');
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const addr = server.address();
      serverPort = typeof addr === 'object' && addr ? addr.port : 0;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('refuses private IPs when allowHttp is false (production mode)', async () => {
      await expect(safeFetch(`https://127.0.0.1:${serverPort}/ok`)).rejects.toThrow(SafeFetchError);
    });

    it('allows loopback test fetch when allowHttp and allowLoopback are enabled for tests', async () => {
      const res = await safeFetch(`http://127.0.0.1:${serverPort}/ok`, { allowHttp: true, allowLoopback: true });
      expect(res.contentType).toBe('text/plain');
      expect(res.data.toString()).toBe('hello safe world');
    });

    it('follows local redirects when allowHttp and allowLoopback are enabled', async () => {
      const res = await safeFetch(`http://127.0.0.1:${serverPort}/redirect-ok`, { allowHttp: true, allowLoopback: true });
      expect(res.data.toString()).toBe('hello safe world');
    });

    it('enforces maxBytes limit', async () => {
      await expect(
        safeFetch(`http://127.0.0.1:${serverPort}/big`, { maxBytes: 100, allowHttp: true, allowLoopback: true }),
      ).rejects.toThrow(/exceeds \d+ bytes/i);
    });
  });
});
