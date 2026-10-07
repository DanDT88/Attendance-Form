import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { Agent as HttpsAgent } from 'node:https';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import ipaddr from 'ipaddr.js';
import { Agent, fetch, type RequestInit, type Response } from 'undici';

/**
 * Outbound connections to hosts that admins type in (webhooks, SFTP, SQL and S3 endpoints) may
 * only reach public unicast addresses, plus private ranges an admin has listed explicitly
 * (DESTINATIONS_ALLOWED_PRIVATE_CIDRS, e.g. an on-premises SFTP server). Link-local (cloud
 * metadata), multicast, reserved and unspecified addresses are never reachable, and neither are
 * this machine's own networks (the Docker network with Postgres and Gotenberg) unless
 * DESTINATIONS_ALLOW_SAME_NETWORK is set for development.
 *
 * The check runs on the address actually connected to (a custom DNS lookup, or a pre-resolved IP
 * for clients without one), so DNS rebinding cannot bypass it. Addresses that embed IPv4
 * (::ffff:a.b.c.d, NAT64, 6to4) are judged by the IPv4 inside; Teredo is refused.
 */
type Cidr = [ipaddr.IPv4 | ipaddr.IPv6, number];

export interface NetworkPolicy {
  allowedCidrs: Cidr[];
  allowSameNetwork: boolean;
}

export class NetworkPolicyError extends Error {
  override readonly name = 'NetworkPolicyError';
  readonly permanent = true;
  constructor(detail: string) {
    super(`Address not allowed: ${detail}`);
  }
}

export function parseNetworkPolicy(env: {
  DESTINATIONS_ALLOWED_PRIVATE_CIDRS?: string;
  DESTINATIONS_ALLOW_SAME_NETWORK?: string | boolean;
}): NetworkPolicy {
  const allowedCidrs = (env.DESTINATIONS_ALLOWED_PRIVATE_CIDRS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((c) => {
      try {
        return ipaddr.parseCIDR(c) as Cidr;
      } catch {
        throw new Error(`DESTINATIONS_ALLOWED_PRIVATE_CIDRS: "${c}" is not a CIDR range`);
      }
    });
  const same = env.DESTINATIONS_ALLOW_SAME_NETWORK;
  return { allowedCidrs, allowSameNetwork: same === true || same === 'true' };
}

const NEVER = new Set([
  'unspecified',
  'broadcast',
  'multicast',
  'linkLocal',
  'reserved',
  'teredo',
  'benchmarking',
  'amt',
  'as112',
  'as112v6',
  'deprecated',
  'orchid2',
  'droneRemoteIdProtocolEntityTags',
  'rfc6145',
  'discard',
]);
const IMDS_V6 = ipaddr.parse('fd00:ec2::254');

/** The IPv4 address inside an IPv4-mapped, NAT64 or 6to4 address. */
function unwrap(addr: ipaddr.IPv4 | ipaddr.IPv6): ipaddr.IPv4 | ipaddr.IPv6 {
  if (addr.kind() !== 'ipv6') return addr;
  const v6 = addr as ipaddr.IPv6;
  const range = v6.range();
  if (range === 'ipv4Mapped') return v6.toIPv4Address();
  const b = v6.toByteArray();
  if (range === 'rfc6052') return ipaddr.fromByteArray(b.slice(12, 16));
  if (range === '6to4') return ipaddr.fromByteArray(b.slice(2, 6));
  return v6;
}

function ownSubnets(): Cidr[] {
  const out: Cidr[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      try {
        out.push(
          ipaddr.parseCIDR(i.cidr ?? `${i.address}/${i.family === 'IPv4' ? 32 : 128}`) as Cidr,
        );
      } catch {
        /* skip odd interfaces */
      }
    }
  }
  return out;
}

const inAny = (a: ipaddr.IPv4 | ipaddr.IPv6, cidrs: Cidr[]) =>
  cidrs.some(([net, bits]) => net.kind() === a.kind() && a.match(net as never, bits));

/** Why an address may not be connected to, or null when it may. */
export function addressRefusal(ip: string, policy: NetworkPolicy): string | null {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(ip.replace(/^\[|\]$/g, '').replace(/%.*$/, ''));
  } catch {
    return `"${ip}" is not an IP address`;
  }
  const addr = unwrap(parsed);
  const range = addr.range();
  if (NEVER.has(range) || (addr.kind() === 'ipv6' && addr.toString() === IMDS_V6.toString()))
    return `${ip} is a ${range} address`;
  if (!policy.allowSameNetwork && inAny(addr, ownSubnets()))
    return `${ip} is on this server's own network`;
  if (range === 'unicast') return null;
  if (inAny(addr, policy.allowedCidrs)) return null;
  return `${ip} is a ${range} address (list it in DESTINATIONS_ALLOWED_PRIVATE_CIDRS to allow)`;
}

/** True when the address is a private one that the policy allows (plain http is allowed there). */
export function isAllowedPrivate(ip: string, policy: NetworkPolicy): boolean {
  try {
    const addr = unwrap(ipaddr.parse(ip));
    return addr.range() !== 'unicast' && inAny(addr, policy.allowedCidrs);
  } catch {
    return false;
  }
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A `dns.lookup` replacement for sockets: refuses the host if any of its addresses is refused
 * (or, with `privateOnly`, if any is not an allowed private address).
 */
export function guardedLookup(policy: NetworkPolicy, privateOnly = false) {
  return (hostname: string, options: { all?: boolean; family?: number }, cb: LookupCallback) => {
    dnsLookup(hostname, { all: true, family: options?.family ?? 0 }, (err, addresses) => {
      if (err) return cb(err, '');
      const list = addresses as LookupAddress[];
      if (!list.length) return cb(new NetworkPolicyError(`${hostname} has no address`), '');
      for (const a of list) {
        const why = addressRefusal(a.address, policy);
        if (why) return cb(new NetworkPolicyError(why), '');
        if (privateOnly && !isAllowedPrivate(a.address, policy))
          return cb(
            new NetworkPolicyError(`plain http is only allowed to listed private networks`),
            '',
          );
      }
      if (options?.all) return cb(null, list);
      cb(null, list[0]!.address, list[0]!.family);
    });
  };
}

/**
 * Resolves a host once and returns a vetted IP to connect to, for clients that cannot take a
 * custom lookup (SFTP, PostgreSQL). Connecting to the returned IP leaves no rebinding window;
 * pass the host name separately for TLS (servername).
 */
export async function resolveAllowed(host: string, policy: NetworkPolicy): Promise<string> {
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare)) {
    const why = addressRefusal(bare, policy);
    if (why) throw new NetworkPolicyError(why);
    return bare;
  }
  return new Promise((resolve, reject) => {
    guardedLookup(policy)(bare, {}, (err, address) =>
      err ? reject(err) : resolve(address as string),
    );
  });
}

const agents = new Map<string, Agent>();
function undiciAgent(policy: NetworkPolicy, privateOnly: boolean): Agent {
  const key = `${JSON.stringify(policy.allowedCidrs.map(([a, b]) => `${a.toString()}/${b}`))}|${policy.allowSameNetwork}|${privateOnly}`;
  let agent = agents.get(key);
  if (!agent) {
    agent = new Agent({
      connect: { lookup: guardedLookup(policy, privateOnly) as never, timeout: 10_000 },
      headersTimeout: 30_000,
      bodyTimeout: 60_000,
    });
    agents.set(key, agent);
  }
  return agent;
}

/** An https.Agent with the guarded lookup, for SDKs that take a Node agent (the S3 client). */
export function guardedHttpsAgent(policy: NetworkPolicy): HttpsAgent {
  return new HttpsAgent({ lookup: guardedLookup(policy) as never, keepAlive: true });
}

/**
 * fetch() for configured URLs: https (plain http only to listed private networks), vetted
 * addresses, no credentials in the URL, redirects never followed, and a time limit.
 */
export async function guardedFetch(
  url: string | URL,
  init: RequestInit & { timeoutMs?: number },
  policy: NetworkPolicy,
): Promise<Response> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new NetworkPolicyError('not a valid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    throw new NetworkPolicyError('only https:// URLs are allowed');
  if (u.username || u.password)
    throw new NetworkPolicyError('put credentials in the secrets, not the URL');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const plain = u.protocol === 'http:';
  // An IP literal never goes through the lookup, so check it here.
  if (isIP(host)) {
    const why = addressRefusal(host, policy);
    if (why) throw new NetworkPolicyError(why);
    if (plain && !isAllowedPrivate(host, policy))
      throw new NetworkPolicyError('plain http is only allowed to listed private networks');
  }
  const { timeoutMs = 30_000, signal, ...rest } = init;
  const timeout = AbortSignal.timeout(timeoutMs);
  return fetch(u, {
    ...rest,
    redirect: 'manual',
    dispatcher: undiciAgent(policy, plain),
    signal: signal ? AbortSignal.any([signal as AbortSignal, timeout]) : timeout,
  });
}

/** Reads at most `max` bytes of a response body (the rest is discarded). */
export async function readLimited(res: Response, max = 64 * 1024): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    const buf = Buffer.from(chunk as Uint8Array);
    chunks.push(buf.subarray(0, Math.max(0, max - size)));
    size += buf.length;
    if (size >= max) break;
  }
  return Buffer.concat(chunks);
}
