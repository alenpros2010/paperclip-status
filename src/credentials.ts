import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { posix } from 'node:path';
import type { OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry';
import { StatusError, type Config } from './client.js';

const MAX_BYTES = 16 * 1024;
type Stat = { uid: number; mode: number; size: number; dev: number; ino: number; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean };
type Handle = {
  stat(): Promise<Stat>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
};
/** Direct-test seam only. makeTool never accepts or forwards these dependencies. */
export type CredentialDependencies = {
  platform: string;
  getuid?: () => number;
  filesystem: { lstat(path: string): Promise<Stat>; open(path: string, flags: number): Promise<Handle> };
};
const realDependencies: CredentialDependencies = {
  platform: process.platform,
  getuid: typeof process.getuid === 'function' ? () => process.getuid!() : undefined,
  filesystem: { lstat: path => lstat(path), open: (path, flags) => open(path, flags) },
};
const validToken = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !/[\r\n]/.test(value);

export async function resolveToken(
  ctx: OpenClawPluginToolContext, config: Config, signal: AbortSignal,
  assertCurrent: () => void, dependencies: CredentialDependencies = realDependencies,
): Promise<string> {
  const guard = () => {
    try { assertCurrent(); } catch { throw new StatusError('access_denied'); }
    if (signal.aborted) throw new StatusError('timeout');
  };
  // Cleanup is deliberately unconditional: a revoked invocation must still close
  // an already-owned or late-opened descriptor. Never expose cleanup errors.
  const close = (handle: Handle) => {
    try { return Promise.resolve(handle.close()).catch(() => {}); } catch { return Promise.resolve(); }
  };
  const step = <T>(operation: () => T | PromiseLike<T>, lateCleanup?: (value: T) => Promise<void>): Promise<T> => {
    guard();
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const abort = () => { if (!done) { done = true; reject(new StatusError('timeout')); } };
      signal.addEventListener('abort', abort, { once: true });
      let pending: Promise<T>;
      try { pending = Promise.resolve(operation()); } catch { pending = Promise.reject(new StatusError('auth')); }
      pending.then(value => {
        signal.removeEventListener('abort', abort);
        if (done) { if (lateCleanup) void lateCleanup(value); return; }
        done = true;
        try { guard(); resolve(value); } catch (error) { if (lateCleanup) void lateCleanup(value); reject(error); }
      }, () => {
        signal.removeEventListener('abort', abort);
        if (done) return;
        done = true;
        try { guard(); reject(new StatusError('auth')); } catch (error) { reject(error); }
      });
      // Covers a resolver that synchronously aborts while being invoked.
      if (signal.aborted) abort();
    });
  };

  const host = await step(() => ctx.resolveApiKeyForProvider!(config.credentialProvider));
  guard();
  if (host !== undefined) {
    if (!validToken(host)) throw new StatusError('auth');
    return host;
  }

  // No implicit global file, DNS name, or Windows ACL assumption. This path is
  // an explicitly opted-in POSIX-only development source, not production auth.
  guard();
  const path = config.developmentCredentialFile;
  if (config.allowDevelopmentCredentialFallback !== true || config.allowLoopbackDevelopment !== true ||
      typeof path !== 'string' || !posix.isAbsolute(path) || /[\u0000\r\n]/.test(path) ||
      path.split('/').some(part => part === '.' || part === '..') ||
      !/^https?:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/?$/.test(config.baseUrl) ||
      dependencies.platform === 'win32' || typeof dependencies.getuid !== 'function') throw new StatusError('auth');
  if (dependencies === realDependencies &&
      (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number')) throw new StatusError('auth');
  // Numeric POSIX flags allow Linux/macOS synthetic tests on a Windows runner;
  // the real Windows dependency branch above always denies before filesystem IO.
  const nofollow = constants.O_NOFOLLOW ?? (dependencies.platform === 'darwin' ? 0x100 : 0x20000);
  const nonblock = constants.O_NONBLOCK ?? (dependencies.platform === 'darwin' ? 0x4 : 0x800);
  let uid: number;
  try { guard(); uid = dependencies.getuid(); guard(); } catch (error) {
    if (error instanceof StatusError) throw error;
    throw new StatusError('auth');
  }
  if (!Number.isSafeInteger(uid) || uid < 0) throw new StatusError('auth');
  const privateFile = (stat: Stat) => stat.isFile() && !stat.isSymbolicLink() && stat.uid === uid &&
    (stat.mode & 0o077) === 0 && Number.isSafeInteger(stat.size) && stat.size >= 0 && stat.size <= MAX_BYTES;
  const before = await step(() => dependencies.filesystem.lstat(path));
  if (!privateFile(before)) throw new StatusError('auth');
  for (let ancestor = posix.dirname(path); ; ancestor = posix.dirname(ancestor)) {
    const stat = await step(() => dependencies.filesystem.lstat(ancestor));
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 ||
        (stat.uid !== uid && stat.uid !== 0)) throw new StatusError('auth');
    if (ancestor === '/') break;
  }
  const handle = await step(() => dependencies.filesystem.open(path, constants.O_RDONLY | nofollow | nonblock), close);
  try {
    const after = await step(() => handle.stat());
    if (!privateFile(after) || before.dev !== after.dev || before.ino !== after.ino) throw new StatusError('auth');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await step(() => handle.read(bytes, length, bytes.length - length, length));
      if (!Number.isSafeInteger(read.bytesRead) || read.bytesRead < 0 || read.bytesRead > bytes.length - length) throw new StatusError('auth');
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > MAX_BYTES) throw new StatusError('auth');
    guard(); // Deny before decoding/parsing secret-bearing bytes.
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.subarray(0, length).toString('utf8').replace(/^\uFEFF/, '')); } catch { throw new StatusError('auth'); }
    guard();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new StatusError('auth');
    const metadata = parsed as Record<string, unknown>;
    if (metadata.version !== 1 || metadata.companyId !== config.companyId ||
        metadata.credentialProvider !== config.credentialProvider || !validToken(metadata.token)) throw new StatusError('auth');
    return metadata.token;
  } finally {
    // Bound cleanup too: an aborted/hung read must not make tool completion wait
    // for the platform to finish closing. The close promise remains observed.
    const cleanup = close(handle);
    if (!signal.aborted) await new Promise<void>(resolve => {
      const abort = () => resolve();
      signal.addEventListener('abort', abort, { once: true });
      cleanup.then(() => { signal.removeEventListener('abort', abort); resolve(); });
      if (signal.aborted) abort();
    });
    guard(); // Cleanup must run even when denied, but must not release a stale token.
  }
}
