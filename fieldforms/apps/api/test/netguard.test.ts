import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addressRefusal,
  guardedFetch,
  NetworkPolicyError,
  parseNetworkPolicy,
  readLimited,
  resolveAllowed,
} from '../src/lib/netguard.js';

/** What tests and development use: loopback and this machine allowed. */
const dev = parseNetworkPolicy({
  DESTINATIONS_ALLOWED_PRIVATE_CIDRS: '127.0.0.0/8,::1/128,10.20.0.0/16',
  DESTINATIONS_ALLOW_SAME_NETWORK: 'true',
});
/** Production default: public addresses only. */
const strict = parseNetworkPolicy({});

describe('address policy', () => {
  it.each([
    '169.254.169.254',
    '::ffff:169.254.169.254',
    '0.0.0.0',
    '255.255.255.255',
    'fe80::1',
    '224.0.0.1',
    'fd00:ec2::254',
    '2001::1', // Teredo
    '192.0.2.10', // documentation, reserved
  ])('never allows %s, even with private ranges listed', (ip) => {
    expect(addressRefusal(ip, dev)).not.toBeNull();
    expect(addressRefusal(ip, strict)).not.toBeNull();
  });

  it.each([
    '127.0.0.1',
    '::1',
    '10.20.3.4',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::7f00:1', // NAT64 of 127.0.0.1
    '2002:7f00:1::', // 6to4 of 127.0.0.1
  ])('allows %s only when its range is listed', (ip) => {
    expect(addressRefusal(ip, strict)).not.toBeNull();
    expect(addressRefusal(ip, dev)).toBeNull();
  });

  it('keeps private ranges that are not listed closed', () => {
    expect(addressRefusal('10.30.0.1', dev)).toContain('DESTINATIONS_ALLOWED_PRIVATE_CIDRS');
    expect(addressRefusal('192.168.1.1', dev)).not.toBeNull();
    expect(addressRefusal('100.64.0.1', dev)).not.toBeNull();
  });

  it('refuses this machine’s own network unless allowed', () => {
    const loopbackListed = parseNetworkPolicy({
      DESTINATIONS_ALLOWED_PRIVATE_CIDRS: '127.0.0.0/8',
    });
    expect(addressRefusal('127.0.0.1', loopbackListed)).toContain('own network');
  });

  it('allows public addresses', () => {
    expect(addressRefusal('41.0.0.1', strict)).toBeNull();
    expect(addressRefusal('2c0f:f8f0::1', strict)).toBeNull();
  });

  it('rejects malformed CIDR settings', () => {
    expect(() => parseNetworkPolicy({ DESTINATIONS_ALLOWED_PRIVATE_CIDRS: '10.0.0.0' })).toThrow(
      'not a CIDR range',
    );
  });

  it('checks names by what they resolve to', async () => {
    await expect(resolveAllowed('localhost', strict)).rejects.toBeInstanceOf(NetworkPolicyError);
    expect(await resolveAllowed('localhost', dev)).toMatch(/^(127\.0\.0\.1|::1)$/);
    await expect(resolveAllowed('169.254.169.254', dev)).rejects.toThrow('linkLocal');
  });
});

describe('guarded fetch', () => {
  let server: Server;
  let port: number;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' }).end('x'.repeat(100_000));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('reaches a listed private server, over plain http only there', async () => {
    const res = await guardedFetch(`http://localhost:${port}/`, {}, dev);
    expect(res.status).toBe(200);
    expect((await readLimited(res, 10)).length).toBe(10);
    await expect(guardedFetch(`http://localhost:${port}/`, {}, strict)).rejects.toThrow();
    await expect(guardedFetch(`https://localhost:${port}/`, {}, strict)).rejects.toThrow();
  });

  it('refuses metadata IP literals and does not follow redirects', async () => {
    await expect(guardedFetch('http://169.254.169.254/latest/meta-data/', {}, dev)).rejects.toThrow(
      'linkLocal',
    );
    const res = await guardedFetch(`http://127.0.0.1:${port}/redirect`, {}, dev);
    expect(res.status).toBe(302);
  });

  it('refuses credentials in the URL and other schemes', async () => {
    await expect(guardedFetch('https://user:pw@example.com/', {}, dev)).rejects.toThrow(
      'credentials',
    );
    await expect(guardedFetch('file:///etc/passwd', {}, dev)).rejects.toThrow('https');
  });
});
