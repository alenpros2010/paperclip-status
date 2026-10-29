import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { makeTool, admitted } from '../dist/index.js';

const companyId = '03b0ee80-f106-475e-bc61-8c226ceda184';
const config = { baseUrl: 'http://127.0.0.1:3100', companyId, credentialProvider: 'paperclip', allowLoopbackDevelopment: true };
const binding = (extra = {}) => Object.freeze({ version: 1, kind: 'owner-dm', companyId, sessionId: 'session', sessionKey: 'key', channel: 'test-private', to: 'owner', assertCurrent: () => true, ...extra });
const context = (extra = {}) => ({ senderIsOwner: true, sessionId: 'session', sessionKey: 'key', memoryAudience: { kind: 'owner-private' }, assertMemoryAudienceCurrent() {}, assertInvocationCurrent() {}, deliveryContext: { channel: 'test-private', to: 'owner' }, resolveApiKeyForProvider: async () => 'fixture-key', toolBindings: { 'paperclip-status': binding() }, ...extra });
const bound = (b) => ({ toolBindings: { 'paperclip-status': b } });
const cli = (extra = {}) => context({ oneShotCliRun: true, memoryAudience: undefined, assertMemoryAudienceCurrent: undefined, deliveryContext: undefined, ...bound(binding({kind:'local-cli',channel:undefined,to:undefined})), ...extra });
async function server(run, intercept) {
  let reads = 0;
  const s = http.createServer((req,res) => {
    reads++;
    if (intercept?.(req,res) === true) return;
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify(req.url.includes('costs/summary') ? { companyId, spendCents:123 } : []));
  });
  s.listen(0,'127.0.0.1'); await once(s,'listening');
  try { await run({...config,baseUrl:`http://127.0.0.1:${s.address().port}`}, () => reads); }
  finally { s.closeAllConnections(); await new Promise(r => s.close(r)); }
}
const absentGroup = { conversationReadOrigin:'delegated', memoryAudience:undefined, assertMemoryAudienceCurrent:undefined, deliveryContext:{channel:'group',to:'public-group'}, toolBindings:undefined };
const deniedCases = [
  ['missing-binding group',context(absentGroup)],
  ['inherited owner audience on group',context({...absentGroup,memoryAudience:{kind:'owner-private'},assertMemoryAudienceCurrent(){}})],
  ['owner false without receipt',context({senderIsOwner:false,toolBindings:undefined})],
  ['sandbox without receipt',cli({sandboxed:true,toolBindings:{}})],
  ['missing session without receipt',cli({sessionId:'',toolBindings:{}})],
  ['missing session key without receipt',cli({sessionKey:' ',toolBindings:{}})],
  ['missing authority without receipt',cli({assertInvocationCurrent:undefined,toolBindings:{}})],
  ['stale authority without receipt',cli({assertInvocationCurrent(){throw Error('stale');},toolBindings:{}})],
  ['public channel without receipt',context({...absentGroup,deliveryContext:{channel:'public',to:'anyone'}})],
  ['explicit non-private flag without receipt',context({...absentGroup,deliveryContext:{channel:'telegram',to:'someone',isPrivate:false}})],
  ['group target without receipt',context({...absentGroup,deliveryContext:{channel:'telegram',to:'public-group'}})],
  ['old privacy boolean binding',context(bound(Object.freeze({privateConversation:true,companyId,sessionId:'session',channel:'test-private',to:'owner'})))],
  ...[undefined,null,false,0,'',[],{}].map(v=>[`malformed binding ${String(v)}`,context(bound(v))]),
  ['unfrozen receipt',context(bound({...binding()}))],
  ['missing live privacy callback',context(bound(binding({assertCurrent:undefined})))],
  ['void live callback',context(bound(binding({assertCurrent:()=>undefined})))],
  ['async live callback',context(bound(binding({assertCurrent:async()=>true})))],
  ['rejected async receipt cannot leak through unhandled rejection',context(bound(binding({assertCurrent:async()=>{throw Error('private stale detail');}})))],
  ['stale receipt',context(bound(binding({assertCurrent:()=>{throw Error('private stale detail');}})))],
  ['false privacy callback',context(bound(binding({assertCurrent:()=>false})))],
  ['stale invocation',context({assertInvocationCurrent(){throw Error('stale');}})],
  ['stale memory',context({assertMemoryAudienceCurrent(){throw Error('stale');}})],
  ['wrong receipt session',context(bound(binding({sessionId:'other'})))],
  ['wrong receipt session key',context(bound(binding({sessionKey:'other'})))],
  ['wrong company',context(bound(binding({companyId:'other'})))],
  ['unknown receipt kind',context(bound(binding({kind:'delegated'})))],
  ['account route mismatch',context({deliveryContext:{channel:'test-private',to:'owner',accountId:'other'}})],
  ['thread route mismatch',context({deliveryContext:{channel:'test-private',to:'owner',threadId:1}})],
  ['terminal receipt on channel route',cli({deliveryContext:{channel:'group',to:'public-group'}})],
  ['terminal receipt with empty route',cli({deliveryContext:{}})],
  ['terminal receipt with outbound capability',cli({delivery:{send:async()=>{}}})],
  ['terminal receipt with inherited audience',cli({memoryAudience:{kind:'owner-private'}})],
  ['terminal receipt without one-shot',cli({oneShotCliRun:undefined})],
  ['terminal receipt with message channel',cli({messageChannel:'telegram'})],
  ['terminal receipt with native channel',cli({nativeChannelId:'group'})],
  ['delegated completion denied by host CLI provenance guard',cli({conversationReadOrigin:'delegated',...bound(binding({kind:'local-cli',channel:undefined,to:undefined,assertCurrent:()=>false}))})],
];
for (const [label,ctx] of deniedCases) test(`deny before secrets/HTTP: ${label}`,async()=>{
  await server(async(cfg,reads)=>{
    let secrets=0; ctx.resolveApiKeyForProvider=async()=>{secrets++;return 'fixture-key';};
    assert.equal(admitted(ctx,companyId),false);
    const result=await makeTool(ctx,cfg).execute('id',{});
    assert.equal(result.details.error,'access_denied'); assert.equal(secrets,0); assert.equal(reads(),0);
    assert.ok(!JSON.stringify(result).includes('123')); assert.ok(!JSON.stringify(result).includes('stale detail'));
  });
});
for (const [label,ctx] of [['attested owner DM',context()],['explicit terminal-only CLI with delegated read-visibility policy',cli({conversationReadOrigin:'delegated'})],['attested DM with delegated read origin',context({conversationReadOrigin:'delegated'})],['owner DM without receipt (option B)',context({toolBindings:undefined})],['owner CLI without receipt (option B)',cli({toolBindings:{}})],['owner delegated read visibility with no route or receipt (option B)',cli({conversationReadOrigin:'delegated',toolBindings:undefined})]]) test(`fixture succeeds: ${label}`,async()=>{
  await server(async(cfg,reads)=>{
    assert.equal(admitted(ctx,companyId),true);
    const result=await makeTool(ctx,cfg).execute('id',{});
    assert.equal(reads(),5); assert.ok(result.content[0].text.includes('ACTIVITY')); assert.equal(result.details.partial,true);
  });
});
for (const field of ['channel','to','accountId','threadId']) test(`route ${field} changes during credential resolution: no HTTP`,async()=>{
  await server(async(cfg,reads)=>{
    const ctx=context(); ctx.resolveApiKeyForProvider=async()=>{ctx.deliveryContext[field]='changed';return 'fixture-key';};
    const result=await makeTool(ctx,cfg).execute('id',{});
    assert.equal(result.details.error,'access_denied'); assert.equal(reads(),0);
  });
});
test('receipt replacement during credential resolution cannot reauthorize invocation',async()=>{
  await server(async(cfg,reads)=>{
    const ctx=context(); ctx.resolveApiKeyForProvider=async()=>{ctx.toolBindings={'paperclip-status':binding()};return 'fixture-key';};
    assert.equal((await makeTool(ctx,cfg).execute('id',{})).details.error,'access_denied'); assert.equal(reads(),0);
  });
});
test('live privacy revoked during credentials prevents HTTP despite unchanged route',async()=>{
  await server(async(cfg,reads)=>{
    let current=true; const ctx=context(bound(binding({assertCurrent:()=>current})));
    ctx.resolveApiKeyForProvider=async()=>{current=false;return 'fixture-key';};
    assert.equal((await makeTool(ctx,cfg).execute('id',{})).details.error,'access_denied'); assert.equal(reads(),0);
  });
});
test('final disclosure checks privacy after all five reads',async()=>{
  await server(async(cfg,reads)=>{
    const ctx=context(bound(binding({assertCurrent:()=>reads()<5})));
    const result=await makeTool(ctx,cfg).execute('id',{});
    assert.equal(reads(),5); assert.equal(result.details.error,'access_denied');
    assert.ok(!result.content[0].text.includes('COSTS')); assert.ok(!result.content[0].text.includes('123'));
  });
});
test('private receipt revoked during backoff prevents authenticated retries',async()=>{
  let current=true;
  await server(async(cfg,reads)=>{
    const result=await makeTool(context(bound(binding({assertCurrent:()=>current}))),cfg).execute('id',{});
    assert.equal(result.details.error,'access_denied'); assert.ok(reads()<=4);
  },(_req,res)=>{current=false;res.statusCode=503;res.end();return true;});
});
test('privacy revoked on summary prevents dependent by-agent read and output',async()=>{
  let current=true;const paths=[];
  await server(async(cfg)=>{
    const result=await makeTool(context(bound(binding({assertCurrent:()=>current}))),cfg).execute('id',{});
    assert.equal(result.details.error,'access_denied'); assert.ok(!paths.some(p=>p.includes('costs/by-agent')));
    assert.ok(!result.content[0].text.includes('COSTS'));
  },(req)=>{paths.push(req.url);if(req.url.includes('costs/summary'))current=false;return false;});
});

for (const mutation of ['group-route','private-route','session','receipt-added','owner','sandbox','authority']) test('option B: changed '+mutation+' during credentials prevents HTTP',async()=>{
  await server(async(cfg,reads)=>{
    const ctx=context({toolBindings:undefined});
    ctx.resolveApiKeyForProvider=async()=>{
      if(mutation==='group-route')ctx.deliveryContext={channel:'group',to:'public-group'};
      if(mutation==='private-route')ctx.deliveryContext.to='other-owner';
      if(mutation==='session')ctx.sessionId='new-session';
      if(mutation==='receipt-added')ctx.toolBindings={'paperclip-status':binding()};
      if(mutation==='owner')ctx.senderIsOwner=false;
      if(mutation==='sandbox')ctx.sandboxed=true;
      if(mutation==='authority')ctx.assertInvocationCurrent=()=>{throw Error('stale');};
      return 'fixture-key';
    };
    const result=await makeTool(ctx,cfg).execute('id',{});
    assert.equal(result.details.error,'access_denied');assert.equal(reads(),0);
  });
});
test('option B: group route introduced after snapshot suppresses output',async()=>{
  let ctx, requests=0;
  await server(async(cfg,reads)=>{
    ctx=context({toolBindings:undefined});
    const result=await makeTool(ctx,cfg).execute('id',{});
    assert.equal(reads(),5);assert.equal(result.details.error,'access_denied');
    assert.ok(!result.content[0].text.includes('COSTS'));assert.ok(!result.content[0].text.includes('123'));
  },()=>{if(++requests===5)ctx.deliveryContext={channel:'group',to:'public-group'};return false;});
});
