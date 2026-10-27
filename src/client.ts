import http, { type RequestOptions } from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type ErrorCode = 'auth' | 'rate_limit' | 'timeout' | 'network' | 'server' | 'invalid_response' | 'response_too_large' | 'destination_denied' | 'access_denied';
export class StatusError extends Error { constructor(public code: ErrorCode, public retryAfterMs = 0) { super(code); } }
export interface Config { baseUrl: string; companyId: string; credentialProvider: string; allowLoopbackDevelopment?: boolean; currency?: string; }
export function validateConfig(value: unknown): Config {
  if (!value || typeof value !== 'object') throw new StatusError('destination_denied');
  const c = value as Config;
  if (typeof c.baseUrl !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c.companyId) || typeof c.credentialProvider !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(c.credentialProvider) || (c.currency !== undefined && !/^[A-Z]{3}$/.test(c.currency)) || (c.allowLoopbackDevelopment !== undefined && typeof c.allowLoopbackDevelopment !== 'boolean')) throw new StatusError('destination_denied');
  let u: URL; try { u = new URL(c.baseUrl); } catch { throw new StatusError('destination_denied'); }
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/' || !['https:', 'http:'].includes(u.protocol)) throw new StatusError('destination_denied');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const loopback = ['127.0.0.1', '::1'].includes(host);
  if (u.protocol === 'http:' && !(loopback && c.allowLoopbackDevelopment === true)) throw new StatusError('destination_denied');
  if (isIP(host) && !publicAddress(host) && !(loopback && c.allowLoopbackDevelopment === true)) throw new StatusError('destination_denied');
  return Object.freeze({ ...c, baseUrl: u.origin });
}
export function publicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
  }
  // Conservative: only global unicast 2000::/3, excluding documentation and mapped IPv4.
  return isIP(ip) === 6 && /^[23]/.test(ip) && !/^2001:(0*db8|0*:)/i.test(ip) && !ip.includes('.');
}
export function retryAfter(value: string | undefined, now = Date.now()): number {
  if (!value) return 250;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.max(0, ms) : 250;
}
export type Get = (path: string, signal: AbortSignal) => Promise<unknown>;
export function pinnedLookup(address: { address: string; family: number }): NonNullable<RequestOptions['lookup']> {
  return ((_hostname: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) => {
    if (options.all) cb(null, [address]);
    else cb(null, address.address, address.family);
  }) as NonNullable<RequestOptions['lookup']>;
}
async function resolveBounded(host: string, signal: AbortSignal) {
  if (isIP(host)) return [{ address: host, family: isIP(host) }];
  return new Promise<{ address: string; family: number }[]>((resolve, reject) => {
    const abort = () => reject(new StatusError('timeout'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    lookup(host, { all: true }).then(resolve, () => reject(new StatusError('network'))).finally(() => signal.removeEventListener('abort', abort));
  });
}
export function createClient(config: Config, token: string, maxBytes = 1_048_576, assertCurrent: () => void = () => {}): Get {
  config = validateConfig(config);
  if (!token || /[\r\n]/.test(token)) throw new StatusError('auth');
  const origin = new URL(config.baseUrl);
  // Never use Node's environment-proxy-enabled global agents. Egress is direct and DNS-pinned.
  const httpAgent = new http.Agent({ keepAlive: false, proxyEnv: {} });
  const httpsAgent = new https.Agent({ keepAlive: false, proxyEnv: {} });
  const guard = () => { try { assertCurrent(); } catch { throw new StatusError('access_denied'); } };
  const prefix = `/api/companies/${config.companyId}/`;
  const permitted = new Set(['agents', 'costs/summary', 'costs/by-agent', 'approvals', 'activity']);
  async function once(path: string, signal: AbortSignal): Promise<unknown> {
    const url = new URL(path, origin);
    if (url.origin !== origin.origin || !url.pathname.startsWith(prefix) || !permitted.has(url.pathname.slice(prefix.length))) throw new StatusError('destination_denied');
    guard(); signal.throwIfAborted();
    const host = origin.hostname.replace(/^\[|\]$/g, '');
    const loopback = ['127.0.0.1', '::1'].includes(host) && config.allowLoopbackDevelopment === true;
    // Resolve once, validate ALL answers, then pin connection lookup to this result (no DNS rebinding).
    const answers = await resolveBounded(host, signal);
    if (!answers.length || (!loopback && answers.some(a => !publicAddress(a.address)))) throw new StatusError('destination_denied');
    const address = answers[0]!;
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      guard(); // Final synchronous authority check, after DNS/backoff, immediately before dispatch.
      const req = (url.protocol === 'https:' ? https : http).request(url, {
        method: 'GET', signal, agent: url.protocol === 'https:' ? httpsAgent : httpAgent, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Accept-Encoding': 'identity' },
        lookup: pinnedLookup(address),
      }, res => {
        const status = res.statusCode ?? 0;
        if (status !== 200) {
          res.destroy();
          reject(new StatusError(status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate_limit' : status >= 500 ? 'server' : 'invalid_response', retryAfter(res.headers['retry-after'])));
          return;
        }
        if (!/^application\/(?:[\w.-]+\+)?json(?:;|$)/i.test(res.headers['content-type'] ?? '')) { res.destroy(); reject(new StatusError('invalid_response')); return; }
        const chunks: Buffer[] = []; let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) { res.destroy(); reject(new StatusError('response_too_large')); }
          else chunks.push(chunk);
        });
        res.on('error', () => reject(new StatusError(signal.aborted ? 'timeout' : 'network')));
        res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new StatusError('invalid_response')); } });
      });
      req.on('error', () => reject(new StatusError(signal.aborted ? 'timeout' : 'network')));
      req.end();
    });
  }
  return async (path, signal) => {
    for (let attempt = 0; ; attempt++) {
      try { return await once(path, signal); }
      catch (e) {
        const err = signal.aborted ? new StatusError('timeout') : e instanceof StatusError ? e : new StatusError('network');
        if (attempt || !['rate_limit', 'network', 'server'].includes(err.code)) throw err;
        const wait = err.code === 'rate_limit' ? err.retryAfterMs : 100;
        await new Promise<void>((resolve, reject) => {
          if (signal.aborted) { reject(new StatusError('timeout')); return; }
          const abort = () => { clearTimeout(timer); reject(new StatusError('timeout')); };
          const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, Math.min(wait, 2_147_483_647));
          signal.addEventListener('abort', abort, { once: true });
        });
      }
    }
  };
}
