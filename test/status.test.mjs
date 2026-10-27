import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createClient, validateConfig, publicAddress, retryAfter, pinnedLookup, StatusError } from '../dist/client.js';
import { snapshot, render, monthBounds, amount, safe, normalizeIssueRuns } from '../dist/status.js';
import entry, { makeTool, admitted } from '../dist/index.js';

const companyId = '03b0ee80-f106-475e-bc61-8c226ceda184';
const c = { baseUrl: 'http://127.0.0.1:3100', companyId, credentialProvider: 'paperclip', allowLoopbackDevelopment: true };
const now = new Date('2026-10-26T15:30:00.000Z');
function fixtures(path) {
  if (path.includes('costs/summary')) return { companyId, spendCents: 123, spendCentsExact: '123.456', pricingComplete: false, estimatedEventCount: 1, unpricedEventCount: 2, pendingAccountingEventCount: 3 };
  if (path.includes('costs/by-agent')) return [{ agentId: 'a', agentName: 'Engineer', costCentsExact: '123.456', estimatedEventCount: 1 }];
  if (path.includes('approvals')) return [{ id: 'approval-123456789', type: 'hire_agent', status: 'pending', createdAt: now.toISOString(), payload: { token: 'hidden-payload' } }];
  if (path.includes('activity')) return [{ createdAt: now.toISOString(), action: 'agent.updated', entityType: 'agent', entityId: 'a', details: { token: 'hidden-activity' } }];
  return [{ id: 'a', name: 'Engineer', status: 'active' }, { id: 'b', name: 'No cost record', status: 'paused' }];
}
const signal = () => AbortSignal.timeout(2000);
function context(extra = {}) {
  return { senderIsOwner: true, conversationReadOrigin: 'direct-operator', memoryAudience: { kind: 'owner-private' }, assertMemoryAudienceCurrent() {}, assertInvocationCurrent() {}, sessionId: 'session', sessionKey: 'host-session', deliveryContext: { channel: 'test-private', to: 'owner' }, toolBindings: { 'paperclip-status': { privateConversation: true, companyId, sessionId: 'session', channel: 'test-private', to: 'owner' } }, resolveApiKeyForProvider: async () => 'synthetic-token', ...extra };
}
async function server(handler, fn) {
  const s = http.createServer(handler); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  try { await fn({ ...c, baseUrl: `http://127.0.0.1:${s.address().port}` }); }
  finally { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); }
}
function json(res, body) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); }

test('happy snapshot: exactly four sections and whitelist only', async () => {
  const calls = []; const s = await snapshot(c, async p => { calls.push(p); return fixtures(p); }, signal(), now);
  assert.deepEqual(s.sections.map(x => x.name), ['overview', 'costs', 'approvals', 'activity']);
  assert.equal(calls.length, 5); assert.ok(calls.every(p => !p.includes('/runs')));
  const text = render(s); assert.ok(text.includes('No cost record')); assert.ok(text.includes('latest run=unknown'));
  assert.ok(!text.includes('hidden-payload')); assert.ok(!text.includes('hidden-activity')); assert.ok(text.includes('123.456 cents')); assert.ok(text.includes('unpriced=2'));
  const costCalls = calls.filter(p => p.includes('costs/')); assert.equal(costCalls[0].split('?')[1], costCalls[1].split('?')[1]);
});
test('empty lists remain scoped, not global zero or no-run', async () => {
  const s = await snapshot(c, async p => p.includes('costs/summary') ? fixtures(p) : [], signal(), now);
  const text = render(s); assert.ok(text.includes('Agents visible: 0')); assert.ok(text.includes('Pending approvals visible: 0')); assert.ok(text.includes('actor-scoped')); assert.ok(!text.includes('no-run'));
});
test('independent timeout preserves other sections', async () => {
  const s = await snapshot(c, async p => { if (p.includes('approvals')) throw new StatusError('timeout'); return fixtures(p); }, signal(), now);
  assert.equal(s.sections[2].error, 'timeout'); assert.ok(render(s).includes('Company total:'));
});
test('summary failure preserves by-agent', async () => {
  const s = await snapshot(c, async p => { if (p.includes('costs/summary')) throw new StatusError('auth'); return fixtures(p); }, signal(), now);
  assert.ok(render(s).includes('Company total unavailable: auth')); assert.ok(render(s).includes('Engineer'));
});
test('malformed list and cross-company summary fail safe', async () => {
  const s = await snapshot(c, async p => p.includes('costs/summary') ? { companyId: 'other', spendCents: 100 } : {}, signal(), now);
  assert.equal(s.sections[0].error, 'invalid_response'); assert.ok(!render(s).includes('100 cents'));
});
test('missing fields and unknown enum preserve uncertainty', async () => {
  const s = await snapshot(c, async p => p.includes('agents') ? [{ name: 'X', status: 'new-enum' }] : fixtures(p), signal(), now);
  assert.ok(render(s).includes('new-enum')); assert.equal(amount(null, undefined), 'unknown');
});
test('reject nonpending approval rows instead of mislabeling', async () => {
  const s = await snapshot(c, async p => p.includes('approvals') ? [{ status: 'approved' }] : fixtures(p), signal(), now);
  assert.equal(s.sections[2].error, 'invalid_response');
});
test('100-row caps and host output bounds report omissions', async () => {
  const s = await snapshot(c, async p => p.includes('agents') || p.includes('approvals') ? Array.from({length: 140}, (_, i) => ({ id: String(i), name: 'x'.repeat(80), status: 'pending' })) : fixtures(p), signal(), now);
  assert.equal(s.sections[0].omitted, 40); assert.equal(s.sections[2].omitted, 40);
  const text = render(s); assert.ok(text.length <= 3600); assert.ok(text.includes('output omitted')); for (const name of ['OVERVIEW','COSTS','APPROVALS','ACTIVITY']) assert.ok(text.includes(name));
});
test('concurrency never exceeds four', async () => {
  let active = 0, max = 0;
  await snapshot(c, async p => { active++; max = Math.max(max, active); await new Promise(r => setTimeout(r, 10)); active--; return fixtures(p); }, signal(), now);
  assert.equal(max, 4);
});
for (const [stamp, start] of [['2026-10-31T18:00:00Z','2026-10-01T00:00:00.000Z'],['2026-11-01T00:00:00Z','2026-11-01T00:00:00.000Z'],['2027-01-01T00:00:00Z','2027-01-01T00:00:00.000Z']]) test(`UTC/Bangkok year-month boundary ${stamp}`, () => { assert.equal(monthBounds(new Date(stamp)).from, start); assert.equal(monthBounds(new Date(stamp)).to, new Date(stamp).toISOString()); });
test('fractional cents are exact, currency only explicit', () => {
  assert.equal(amount('123.456', 123, 'USD'), '1.23456 USD'); assert.equal(amount('0', 0, 'USD'), '0.00 USD'); assert.equal(amount('0.005', 0, 'USD'), '0.00005 USD'); assert.equal(amount('99999999999999999999.1', 0, 'USD'), '999999999999999999.991 USD'); assert.equal(amount('bad', 123), 'unknown'); assert.equal(amount(undefined, -1), 'unknown'); assert.equal(amount(undefined, 0), '0 cents (currency unconfirmed)');
});
test('format injection stripped and token redacted', async () => {
  assert.equal(safe('<script>\u202e\n_@all_'), 'script all');
  const s = await snapshot(c, async p => p.includes('agents') ? [{ name: 'synthetic-token', status: 'active' }] : fixtures(p), signal(), now);
  assert.ok(!render(s, 'synthetic-token').includes('synthetic-token'));
});
test('source-only issue runs use runId and deterministic tie-break; no raw telemetry', () => {
  const r = normalizeIssueRuns([{ runId: 'z', agentId: 'a', status: 'queued', createdAt: now.toISOString(), telemetry: 'secret' }, { runId: 'a', createdAt: now.toISOString() }]);
  assert.deepEqual(r.map(x => x.runId), ['a','z']); assert.equal(r[1].status, 'queued'); assert.ok(!JSON.stringify(r).includes('secret'));
});
test('fixed origin config rejects unsafe destinations', () => {
  for (const url of ['http://example.com','https://user:pass@example.com','https://example.com/path','https://example.com?x=1','https://10.0.0.1','https://169.254.169.254','https://[::ffff:127.0.0.1]','file:///tmp']) assert.throws(() => validateConfig({ ...c, baseUrl: url, allowLoopbackDevelopment: false }));
  assert.equal(validateConfig(c).baseUrl, c.baseUrl);
  assert.throws(() => validateConfig({ ...c, allowLoopbackDevelopment: 'true' }));
});
test('deny private DNS addresses and conservative IPv6', () => { for (const ip of ['10.1.1.1','127.0.0.1','169.254.169.254','100.64.0.1','172.16.0.1','192.168.0.1','::1','fe80::1','fc00::1','2001:db8::1','::ffff:127.0.0.1']) assert.equal(publicAddress(ip), false, ip); assert.equal(publicAddress('8.8.8.8'), true); });
test('Retry-After delta and HTTP date', () => { assert.equal(retryAfter('2'), 2000); assert.equal(retryAfter(new Date(5000).toUTCString(), 1000), 4000); assert.equal(retryAfter('invalid'), 250); });
for (const code of [401,403]) test(`HTTP ${code}: no retry, no response/secret leak`, async () => {
  let count = 0;
  await server((req,res) => { count++; assert.equal(req.method, 'GET'); assert.equal(req.headers.authorization,'Bearer synthetic-token'); res.statusCode = code; res.end('secret-response-body'); }, async cfg => { await assert.rejects(createClient(validateConfig(cfg),'synthetic-token')(`/api/companies/${companyId}/agents`, signal()), e => e.code === 'auth' && !e.message.includes('secret')); });
  assert.equal(count, 1);
});
test('429 honors Retry-After and retries only once', async () => {
  let count = 0; const start = Date.now();
  await server((req,res) => { if (++count === 1) { res.statusCode=429; res.setHeader('Retry-After','0.05'); res.end(); } else json(res, []); }, async cfg => { assert.deepEqual(await createClient(validateConfig(cfg),'synthetic-token')(`/api/companies/${companyId}/agents`, signal()), []); });
  assert.equal(count,2); assert.ok(Date.now()-start >= 50);
});
test('Retry-After beyond deadline aborts without retry', async () => {
  let count=0;
  await server((req,res) => { count++; res.statusCode=429; res.setHeader('Retry-After','60'); res.end(); }, async cfg => { await assert.rejects(createClient(validateConfig(cfg),'x')(`/api/companies/${companyId}/agents`, AbortSignal.timeout(50)), e => e.code==='timeout'); }); assert.equal(count,1);
});
test('5xx retries once and stops', async () => { let count=0; await server((req,res) => { count++; res.statusCode=503; res.end('private'); }, async cfg => { await assert.rejects(createClient(validateConfig(cfg),'x')(`/api/companies/${companyId}/agents`, signal()), e => e.code==='server'); }); assert.equal(count,2); });
test('redirect not followed; arbitrary URL and issue-runs denied', async () => {
  let count=0; await server((req,res) => { count++; res.statusCode=302; res.setHeader('Location','http://127.0.0.1:1/secret'); res.end(); }, async cfg => {
    const get=createClient(validateConfig(cfg),'x'); await assert.rejects(get(`/api/companies/${companyId}/agents`,signal()), e => e.code==='invalid_response');
    for (const p of ['http://example.com', '/api/issues/x/runs', '/api/companies/other/agents', `/api/companies/${companyId}/heartbeat-runs`]) await assert.rejects(get(p,signal()), e => e.code==='destination_denied');
  }); assert.equal(count,1);
});
test('stream bytes bounded before JSON parse', async () => { await server((req,res) => { res.setHeader('Content-Type','application/json'); res.end('['+' '.repeat(1000)+']'); }, async cfg => { await assert.rejects(createClient(validateConfig(cfg),'x',100)(`/api/companies/${companyId}/agents`,signal()), e => e.code==='response_too_large'); }); });
test('malformed JSON and content type fail safe', async () => { for (const body of ['broken','<html>']) await server((req,res) => { if (body==='broken') res.setHeader('Content-Type','application/json'); res.end(body); }, async cfg => { await assert.rejects(createClient(validateConfig(cfg),'x')(`/api/companies/${companyId}/agents`,signal()), e => e.code==='invalid_response'); }); });
test('hung HTTP aborted by deadline', async () => { await server(() => {}, async cfg => { await assert.rejects(createClient(validateConfig(cfg),'x')(`/api/companies/${companyId}/agents`,AbortSignal.timeout(50)), e => e.code==='timeout'); }); });
test('tool denies owner/channel/spoofing before secret/network', async () => {
  // No tool binding is required: no existing caller (Telegram, CLI, gateway) provides a
  // paperclip-status binding, so requiring one makes the tool unreachable. Host attestation
  // (owner + direct-operator + owner-private audience + session + assert fns) is the gate.
  // A binding, when present, must still match (see deliveryContext group case below).
  // Origin 'delegated' is allowed: a CLI turn is 'delegated' with no memory audience
  // (output goes to the owner's own terminal, inherently private). When an audience IS
  // present it must be owner-private.
  for (const extra of [{senderIsOwner:false}, {memoryAudience:{kind:'conversation'}}, {assertInvocationCurrent:undefined}, {sandboxed:true}, {deliveryContext:{channel:'group',to:'group'}}]) {
    let resolved=0; const ctx=context({...extra,resolveApiKeyForProvider:async()=>{resolved++;return 'x';}});
    assert.equal(admitted(ctx,companyId),false); assert.equal((await makeTool(ctx,c).execute('id',{})).details.error,'access_denied'); assert.equal(resolved,0);
  }
  // A present-but-wrong binding still denies.
  assert.equal(admitted(context({toolBindings:{'paperclip-status':{privateConversation:true,companyId,sessionId:'session',channel:'other',to:'owner'}}}),companyId),false);
  // No binding at all is admitted when host attestation holds (the reachable path).
  assert.equal(admitted(context({toolBindings:{}}),companyId),true);
  // CLI-style turn (delegated origin, no memory audience, no delivery channel) is admitted:
  // output goes to the owner's own terminal, inherently private.
  assert.equal(admitted(context({conversationReadOrigin:'delegated', memoryAudience:undefined, assertMemoryAudienceCurrent:undefined, deliveryContext:undefined, toolBindings:{}}),companyId),true);
  assert.equal((await makeTool(context(),c).execute('id',{baseUrl:'evil',privateConversation:true})).details.error,'access_denied');
});
test('secret resolution failure redacted', async () => {
  const result = await makeTool(context({resolveApiKeyForProvider:async()=>{throw new Error('secret-exception');}}),c).execute('id',{});
  assert.ok(!JSON.stringify(result).includes('secret-exception')); assert.equal(result.details.error,'auth');
});
test('isolated SDK entry registration + authorized fake-HTTP integration', async () => {
  const tools=[],commands=[]; entry.register({pluginConfig:c,registerTool:(...a)=>tools.push(a),registerCommand:x=>commands.push(x)});
  assert.equal(tools.length,1); assert.equal(commands[0].name,'paperclip-status'); assert.equal(commands[0].requireAuth,true); assert.equal(commands[0].requiresAuth,undefined);
  const deniedCommand=await commands[0].handler({senderIsOwner:true}); assert.ok(deniedCommand.text.includes('no API reads'));
  let reads=0; await server((req,res) => { reads++; assert.equal(req.method,'GET'); json(res,fixtures(req.url)); }, async cfg => {
    const result=await makeTool(context(),cfg).execute('id',{}); assert.equal(result.content.length,1); assert.ok(result.content[0].text.includes('ACTIVITY')); assert.ok(!JSON.stringify(result).includes('synthetic-token')); assert.equal(result.details.partial,true);
  }); assert.equal(reads,5);
});
test('authority revoked before output suppresses sensitive data', async () => {
  let checks=0; await server((req,res)=>json(res,fixtures(req.url)),async cfg=>{
    const result=await makeTool(context({assertInvocationCurrent(){ if (++checks>=3) throw new Error('revoked-private'); }}),cfg).execute('id',{});
    assert.equal(result.details.error,'access_denied'); assert.ok(!JSON.stringify(result).includes('Engineer'));
  });
});
test('outer cancellation honored before credential/network', async () => {
  const abort = new AbortController(); abort.abort(); let resolved=0;
  const result=await makeTool(context({resolveApiKeyForProvider:async()=>{resolved++;return 'x';}}),c).execute('id',{},abort.signal);
  assert.equal(result.details.error,'timeout'); assert.equal(resolved,0);
});
test('hostname pinning honors Node 24 all-address callback contract', async () => {
  await server((req,res) => json(res, []), async cfg => {
    const url = new URL(cfg.baseUrl); url.hostname = 'nonexistent.invalid';
    const body = await new Promise((resolve,reject) => {
      http.get(url, { agent: new http.Agent({keepAlive:false,proxyEnv:{}}), autoSelectFamily: true, lookup: pinnedLookup({address:'127.0.0.1',family:4}) }, res => { let body=''; res.on('data',x=>body+=x); res.on('end',()=>resolve(body)); }).on('error',reject);
    });
    assert.equal(body,'[]');
  });
});
test('environment-proxy global agent cannot intercept client credential', async () => {
  let proxyReads=0, destinationReads=0;
  await server((req,res) => { proxyReads++; json(res,[]); }, async proxy => {
    const original=http.globalAgent;
    http.globalAgent=new http.Agent({keepAlive:false,proxyEnv:{HTTP_PROXY:proxy.baseUrl,NO_PROXY:''}});
    try {
      await server((req,res) => { destinationReads++; json(res,[]); }, async cfg => {
        await new Promise((resolve,reject)=>http.get(cfg.baseUrl,res=>{res.resume();res.on('end',resolve);}).on('error',reject));
        assert.equal(proxyReads,1,'test global agent must actually use fake proxy');
        await createClient(validateConfig(cfg),'synthetic-token')(`/api/companies/${companyId}/agents`,signal());
      });
    } finally { http.globalAgent.destroy(); http.globalAgent=original; }
  });
  assert.equal(proxyReads,1); assert.equal(destinationReads,1);
});
for (const value of ['2147484','Fri, 01 Jan 2100 00:00:00 GMT']) test(`oversize Retry-After cannot timer-overflow: ${value}`, async () => {
  let count=0; await server((req,res)=>{count++;res.statusCode=429;res.setHeader('Retry-After',value);res.end();},async cfg=>{
    await assert.rejects(createClient(validateConfig(cfg),'x')(`/api/companies/${companyId}/agents`,AbortSignal.timeout(50)),e=>e.code==='timeout');
  }); assert.equal(count,1);
});
test('raw credential redacted before every differing field truncation', async () => {
  for (const secret of ['T'.repeat(120),'A_<>'.repeat(40),'x']) {
    const s=await snapshot(c,async p=> {
      const data=fixtures(p);
      if (p.includes('costs/summary')) return {...data,estimatedEventCount:secret};
      if (p.includes('agents')) return [{id:secret,name:secret,status:secret}];
      if (p.includes('costs/by-agent')) return [{agentId:secret,agentName:secret,costCents:0}];
      if (p.includes('approvals')) return [{id:secret,type:secret,status:'pending'}];
      return [{entityId:secret,action:secret,entityType:secret}];
    },signal(),now,secret);
    const text=render(s,secret); assert.ok(text.length<=3600);
    if (secret.length>80) for(const n of [12,36,80]) assert.ok(!text.includes(safe(secret,n)),`leaked ${n}-character prefix`);
  }
});
test('revocation during backoff prevents authenticated retry', async () => {
  let current=true,count=0;
  await server((req,res)=>{count++;current=false;res.statusCode=503;res.end();},async cfg=>{
    await assert.rejects(createClient(validateConfig(cfg),'x',1_048_576,()=>{if(!current)throw Error('revoked');})(`/api/companies/${companyId}/agents`,signal()),e=>e.code==='access_denied');
  }); assert.equal(count,1);
});
test('revocation after summary prevents dependent by-agent read', async () => {
  let current=true;const calls=[];
  await server((req,res)=>{calls.push(req.url);if(req.url.includes('costs/summary'))current=false;json(res,fixtures(req.url));},async cfg=>{
    const result=await makeTool(context({assertInvocationCurrent(){if(!current)throw Error('revoked');}}),cfg).execute('id',{});
    assert.equal(result.details.error,'access_denied');
  }); assert.ok(!calls.some(p=>p.includes('costs/by-agent')));
});
