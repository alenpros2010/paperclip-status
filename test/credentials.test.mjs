import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { resolveToken } from '../dist/credentials.js';
import { makeTool } from '../dist/index.js';

const companyId = '03b0ee80-f106-475e-bc61-8c226ceda184';
const config = { baseUrl: 'http://127.0.0.1:1', companyId, credentialProvider: 'paperclip', allowLoopbackDevelopment: true };
const development = { ...config, allowDevelopmentCredentialFallback: true, developmentCredentialFile: '/private/key.json' };
const token = 'synthetic-file-secret';
const metadata = overrides => JSON.stringify({ version: 1, companyId, credentialProvider: 'paperclip', token, ...overrides });
const stat = overrides => ({ uid: 1000, mode: 0o100600, size: 0, dev: 1, ino: 2,
  isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, ...overrides });
function fixture(raw = metadata(), options = {}) {
  const bytes = Buffer.from(raw); const calls = { lstat: [], open: [], read: [], stat: 0, close: 0, uid: 0 };
  const file = stat({ size: bytes.length, ...options.file });
  const handle = {
    async stat() { calls.stat++; return options.onStat ? options.onStat() : stat({ ...file, ...options.descriptor }); },
    async read(buffer, offset, length, position) {
      calls.read.push({ offset, length, position, capacity: buffer.length });
      if (options.onRead) return options.onRead(buffer, offset, length, position);
      const count = Math.min(length, Math.max(0, bytes.length - position), options.chunk ?? Infinity);
      bytes.copy(buffer, offset, position, position + count); return { bytesRead: count };
    },
    async close() { calls.close++; if (options.onClose) return options.onClose(); },
  };
  const dependencies = { platform: 'linux', getuid() { calls.uid++; return 1000; }, filesystem: {
    async lstat(path) {
      calls.lstat.push(path);
      if (options.onLstat) return options.onLstat(path);
      return path === development.developmentCredentialFile ? file : stat({ mode: 0o40755, uid: 0, isFile: () => false, isDirectory: () => true, ...options.directory });
    },
    async open(path, flags) { calls.open.push({ path, flags }); return options.onOpen ? options.onOpen(handle) : handle; },
  } };
  return { dependencies, calls, handle };
}
function context(resolver, live = () => true) {
  return { senderIsOwner: true, sessionId: 'session', sessionKey: 'key', memoryAudience: { kind: 'owner-private' },
    assertInvocationCurrent() {}, assertMemoryAudienceCurrent() {}, deliveryContext: { channel: 'fixture-private', to: 'owner' },
    resolveApiKeyForProvider: resolver, toolBindings: { 'paperclip-status': Object.freeze({ version: 1, kind: 'owner-dm', companyId,
      sessionId: 'session', sessionKey: 'key', channel: 'fixture-private', to: 'owner', assertCurrent: live }) } };
}
const freshSignal = () => new AbortController().signal;
const direct = (f, { resolver = async () => undefined, c = development, signal = freshSignal(), guard = () => {} } = {}) =>
  resolveToken(context(resolver), c, signal, guard, f.dependencies);
const fails = (promise, code = 'auth') => assert.rejects(promise, error => {
  assert.equal(error.message, code); assert.equal(error.code, code); assert.ok(!String(error).includes(token)); return true;
});
const tick = () => new Promise(resolve => setImmediate(resolve));
async function prompt(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('not promptly cancelled')), 500); })]); }
  finally { clearTimeout(timer); }
}

// Every filesystem/uid dependency below is synthetic POSIX, even on Windows.
for (const value of ['host-key', ' padded-host-key ']) test(`host credential valid: ${JSON.stringify(value)}; zero filesystem IO`, async () => {
  const f = fixture(); assert.equal(await direct(f, { resolver: () => value }), value);
  assert.equal(f.calls.uid, 0); assert.equal(f.calls.lstat.length, 0);
});
for (const value of ['', ' ', 'bad\r\nkey', null, false, 0, 123, {}, [], true]) test(`host invalid ${JSON.stringify(value)} never falls back`, async () => {
  const f = fixture(); await fails(direct(f, { resolver: async () => value })); assert.equal(f.calls.lstat.length, 0);
});
for (const asyncFailure of [false, true]) test(`host ${asyncFailure ? 'async' : 'sync'} failure has constant diagnostics and no fallback`, async () => {
  const f = fixture(); const resolver = asyncFailure ? async () => { throw Error(token); } : () => { throw Error(token); };
  await fails(direct(f, { resolver })); assert.equal(f.calls.lstat.length, 0);
});
for (const c of [config, { ...development, allowDevelopmentCredentialFallback: false },
  { ...development, allowLoopbackDevelopment: false }, { ...development, developmentCredentialFile: undefined },
  { ...development, developmentCredentialFile: 'relative.json' }, { ...development, developmentCredentialFile: '/private/../key.json' },
  { ...development, baseUrl: 'https://example.com' }, { ...development, baseUrl: 'http://localhost' },
  { ...development, baseUrl: 'http://2130706433' }, { ...development, baseUrl: 'http://127.1' }]) {
  test(`fallback opt-in/destination gate denies without IO: ${JSON.stringify(c)}`, async () => {
    const f = fixture(); await fails(direct(f, { c })); assert.equal(f.calls.uid, 0); assert.equal(f.calls.lstat.length, 0);
  });
}
test('synthetic Windows denies fallback before getuid or filesystem IO', async () => {
  const f = fixture(); f.dependencies.platform = 'win32'; await fails(direct(f)); assert.equal(f.calls.uid, 0); assert.equal(f.calls.lstat.length, 0);
});
test('POSIX getuid missing/failure denies before filesystem IO', async () => {
  for (const getuid of [undefined, () => { throw Error(token); }, () => -1]) {
    const f = fixture(); f.dependencies.getuid = getuid; await fails(direct(f)); assert.equal(f.calls.lstat.length, 0);
  }
});
for (const raw of [metadata(), '\uFEFF' + metadata()]) test(`synthetic POSIX scoped ${raw.startsWith('\uFEFF') ? 'BOM' : 'plain'} metadata succeeds`, async () => {
  const f = fixture(raw, { chunk: 3 }); assert.equal(await direct(f), token); assert.equal(f.calls.close, 1);
  assert.deepEqual(f.calls.lstat, ['/private/key.json', '/private', '/']);
  assert.equal(f.calls.open.length, 1); assert.equal(f.calls.read[0].capacity, 16 * 1024 + 1);
  const nofollow = fs.constants.O_NOFOLLOW ?? 0x20000; const nonblock = fs.constants.O_NONBLOCK ?? 0x800;
  assert.equal(f.calls.open[0].flags, fs.constants.O_RDONLY | nofollow | nonblock);
});
test('synthetic POSIX literal IPv6 loopback HTTPS is eligible', async () => {
  const f = fixture(); assert.equal(await direct(f, { c: { ...development, baseUrl: 'https://[::1]:443' } }), token);
});
for (const raw of [metadata({ version: 2 }), metadata({ companyId: 'other' }), metadata({ credentialProvider: 'other' }),
  metadata({ token: '' }), metadata({ token: ' ' }), metadata({ token: 'bad\r\nkey' }), metadata({ token: null }),
  metadata({ token: 42 }), JSON.stringify({ version: 1, companyId, credentialProvider: 'paperclip' }),
  JSON.stringify({ token }), 'null', '[]', '', '{"token":"' + token + '", malformed']) {
  test(`synthetic metadata rejects malformed/missing/mismatched fields #${Buffer.byteLength(raw)}-${raw.slice(0, 12)}`, async () => {
    const f = fixture(raw); await fails(direct(f)); assert.equal(f.calls.close, 1);
  });
}
for (const [name, options] of [
  ['file symlink', { file: { isSymbolicLink: () => true } }], ['nonregular', { file: { isFile: () => false } }],
  ['wrong owner', { file: { uid: 1001 } }], ['group-readable', { file: { mode: 0o100640 } }],
  ['other-readable', { file: { mode: 0o100604 } }], ['initial oversized', { file: { size: 16385 } }],
  ['ancestor symlink', { directory: { isSymbolicLink: () => true } }], ['ancestor group writable', { directory: { mode: 0o40775 } }],
  ['ancestor other writable sticky', { directory: { mode: 0o41777 } }], ['ancestor wrong owner', { directory: { uid: 1001 } }],
  ['ancestor nondirectory', { directory: { isDirectory: () => false } }],
  ['descriptor mode changed', { descriptor: { mode: 0o100644 } }], ['descriptor owner changed', { descriptor: { uid: 1001 } }],
  ['descriptor nonregular', { descriptor: { isFile: () => false } }], ['descriptor inode substituted', { descriptor: { ino: 3 } }],
  ['descriptor device substituted', { descriptor: { dev: 2 } }], ['descriptor oversized', { descriptor: { size: 16385 } }],
]) test(`synthetic POSIX denies ${name}`, async () => {
  const f = fixture(metadata(), options); await fails(direct(f)); assert.equal(f.calls.open.length, name.startsWith('descriptor') ? 1 : 0);
  assert.equal(f.calls.close, f.calls.open.length);
});
test('bounded read detects growth beyond initial/fstat size and never allocates/read past max+1', async () => {
  const f = fixture(' '.repeat(17000), { file: { size: 1 }, descriptor: { size: 1 }, chunk: 17 });
  await fails(direct(f)); assert.equal(f.calls.close, 1);
  assert.ok(f.calls.read.every(r => r.capacity === 16385 && r.offset + r.length <= 16385));
  assert.equal(f.calls.read.at(-1).position + Math.min(17, f.calls.read.at(-1).length), 16385);
});
test('exact 16KiB JSON succeeds, plus one byte denies', async () => {
  const raw = metadata(); const f = fixture(raw + ' '.repeat(16384 - Buffer.byteLength(raw)));
  assert.equal(await direct(f), token); assert.equal(f.calls.close, 1);
  const growing = fixture(raw + ' '.repeat(16385 - Buffer.byteLength(raw)), { file: { size: 16384 }, descriptor: { size: 16384 } });
  await fails(direct(growing)); assert.equal(growing.calls.close, 1);
});
for (const phase of ['lstat', 'open', 'stat', 'read']) test(`synthetic ${phase} failure is constant auth`, async () => {
  const options = { ['on' + phase[0].toUpperCase() + phase.slice(1)]: async () => { throw Error(token); } };
  const f = fixture(metadata(), options); await fails(direct(f)); assert.equal(f.calls.close, ['stat', 'read'].includes(phase) ? 1 : 0);
});
test('pre-abort performs zero resolver/getuid/filesystem IO', async () => {
  const controller = new AbortController(); controller.abort(); const f = fixture(); let hosts = 0;
  await fails(direct(f, { signal: controller.signal, resolver() { hosts++; return undefined; } }), 'timeout');
  assert.equal(hosts, 0); assert.equal(f.calls.uid, 0); assert.equal(f.calls.lstat.length, 0);
});
test('pre-denial performs zero resolver or filesystem IO', async () => {
  const f = fixture(); let hosts = 0; await fails(direct(f, { resolver() { hosts++; return undefined; }, guard() { throw Error(token); } }), 'access_denied');
  assert.equal(hosts, 0); assert.equal(f.calls.lstat.length, 0);
});
for (const phase of ['host', 'lstat', 'open', 'stat', 'read']) test(`prompt abort races hung ${phase}`, async () => {
  const controller = new AbortController(); let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const hang = () => { entered(); return new Promise(() => {}); };
  const options = phase === 'host' ? {} : { ['on' + phase[0].toUpperCase() + phase.slice(1)]: hang };
  const f = fixture(metadata(), options); const result = direct(f, { signal: controller.signal, ...(phase === 'host' ? { resolver: hang } : {}) });
  await started; controller.abort(); await prompt(fails(result, 'timeout'));
  assert.equal(f.calls.close, ['stat', 'read'].includes(phase) ? 1 : 0);
});
test('late-opened descriptor closes after cancellation without stat/read', async () => {
  const controller = new AbortController(); let opened; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = fixture(metadata(), { onOpen: () => { entered(); return new Promise(resolve => { opened = resolve; }); } });
  const result = direct(f, { signal: controller.signal }); await started; controller.abort(); await prompt(fails(result, 'timeout'));
  opened(f.handle); await tick(); assert.equal(f.calls.close, 1); assert.equal(f.calls.stat, 0); assert.equal(f.calls.read.length, 0);
});
test('synchronous resolver cancellation remains prompt', async () => {
  const controller = new AbortController(); const f = fixture();
  await prompt(fails(direct(f, { signal: controller.signal, resolver() { controller.abort(); return new Promise(() => {}); } }), 'timeout'));
});
for (const phase of ['host', 'lstat', 'open', 'stat', 'read']) test(`authority revoked during ${phase} denies before next step/parsing`, async () => {
  let live = true; const f = fixture(metadata());
  const options = { guard() { if (!live) throw Error(token); } };
  if (phase === 'host') options.resolver = async () => { live = false; return undefined; };
  else if (phase === 'lstat') { const original = f.dependencies.filesystem.lstat; f.dependencies.filesystem.lstat = async path => { const value = await original(path); live = false; return value; }; }
  else if (phase === 'open') f.dependencies.filesystem.open = async () => { live = false; return f.handle; };
  else if (phase === 'stat') { const original = f.handle.stat; f.handle.stat = async () => { const value = await original(); live = false; return value; }; }
  else { const original = f.handle.read; f.handle.read = async (...args) => { const value = await original(...args); live = false; return value; }; }
  await fails(direct(f, options), 'access_denied');
  if (phase === 'host') assert.equal(f.calls.lstat.length, 0);
  if (phase === 'open') assert.equal(f.calls.stat, 0);
  assert.equal(f.calls.close, ['open', 'stat', 'read'].includes(phase) ? 1 : 0);
});
test('authority revocation during descriptor close cannot release a token', async () => {
  let live = true; const f = fixture(metadata(), { onClose: async () => { live = false; } });
  await fails(direct(f, { guard() { if (!live) throw Error(token); } }), 'access_denied');
  assert.equal(f.calls.close, 1);
});
test('hung close cannot defeat aborted read deadline', async () => {
  const controller = new AbortController(); let entered; const started = new Promise(resolve => { entered = resolve; });
  const f = fixture(metadata(), { onRead: () => { entered(); return new Promise(() => {}); }, onClose: () => new Promise(() => {}) });
  const result = direct(f, { signal: controller.signal }); await started; controller.abort(); await prompt(fails(result, 'timeout')); assert.equal(f.calls.close, 1);
});

// Public entrypoint uses REAL platform dependencies, never the synthetic seam.
// Replace IO/HTTP with throwing spies only; no real credential files or requests.
test('public tool returns only generic errors; real dependencies make zero filesystem/HTTP calls', async () => {
  let files = 0, requests = 0, logs = 0;
  const original = { lstat: fs.promises.lstat, open: fs.promises.open, http: http.request, https: https.request, error: console.error };
  fs.promises.lstat = fs.promises.open = async () => { files++; throw Error('forbidden fixture IO'); };
  http.request = https.request = () => { requests++; throw Error('forbidden fixture HTTP'); };
  console.error = () => { logs++; }; syncBuiltinESMExports();
  try {
    for (const value of ['', ' ', 'bad\r\nkey', null, false, 1, {}]) {
      const result = await makeTool(context(async () => value), config).execute('id', {});
      assert.deepEqual(result.details, { error: 'auth' }); assert.equal(result.content[0].text, 'Paperclip status unavailable: auth.');
    }
    for (const resolver of [() => { throw Error(token); }, async () => { throw Error(token); }, async () => undefined]) {
      const result = await makeTool(context(resolver), config).execute('id', {}); assert.equal(result.details.error, 'auth');
      assert.ok(!JSON.stringify(result).includes(token));
    }
    const hungController = new AbortController(); let hostEntered;
    const hostStarted = new Promise(resolve => { hostEntered = resolve; });
    const hungResult = makeTool(context(() => { hostEntered(); return new Promise(() => {}); }), config).execute('id', {}, hungController.signal);
    await hostStarted; hungController.abort();
    assert.equal((await prompt(hungResult)).details.error, 'timeout');
    const validCtx = context(async () => { validCtx.deliveryContext.to = 'group'; return token; });
    assert.equal((await makeTool(validCtx, config).execute('id', {})).details.error, 'access_denied');
    for (const mutation of ['privacy', 'route', 'receipt']) {
      let live = true; const ctx = context(async () => {
        if (mutation === 'privacy') live = false;
        if (mutation === 'route') ctx.deliveryContext.to = 'group';
        if (mutation === 'receipt') ctx.toolBindings['paperclip-status'] = Object.freeze({ ...ctx.toolBindings['paperclip-status'] });
        return undefined;
      }, () => live);
      const result = await makeTool(ctx, development).execute('id', {}); assert.equal(result.details.error, 'access_denied');
    }
    const controller = new AbortController(); controller.abort(); let hosts = 0;
    const result = await makeTool(context(async () => { hosts++; return token; }), config).execute('id', {}, controller.signal);
    assert.equal(result.details.error, 'timeout'); assert.equal(hosts, 0);
    // This is native Windows deny evidence, not a real POSIX permission/ACL test.
    if (process.platform === 'win32') {
      const nativeConfig = { ...development, developmentCredentialFile: 'C:\\synthetic\\key.json' };
      const denied = await makeTool(context(async () => undefined), nativeConfig).execute('id', {});
      assert.ok(['auth', 'access_denied'].includes(denied.details.error));
    }
    assert.equal(files, 0); assert.equal(requests, 0); assert.equal(logs, 0);
  } finally {
    fs.promises.lstat = original.lstat; fs.promises.open = original.open; http.request = original.http; https.request = original.https;
    console.error = original.error; syncBuiltinESMExports();
  }
});
