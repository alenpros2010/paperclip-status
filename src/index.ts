import { Type } from 'typebox';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { definePluginEntry, type OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry';
import { createClient, validateConfig, StatusError } from './client.js';
import { snapshot, render } from './status.js';

// Resolve the Paperclip board key. Prefer the host auth system
// (resolveApiKeyForProvider); fall back to the claimed-key file that
// Paperclip agents on this host use (~/.openclaw/workspace/paperclip-claimed-api-key.json)
// only when the host reports no credential (undefined). A host auth *failure*
// (throw) is an auth error and does not fall back.
async function resolveToken(ctx: OpenClawPluginToolContext, provider: string, signal: AbortSignal): Promise<string> {
  const viaHost = await new Promise<string | undefined>((resolve, reject) => {
    const abort = () => reject(new StatusError('timeout'));
    signal.addEventListener('abort', abort, { once: true });
    ctx.resolveApiKeyForProvider!(provider).then(resolve, (e) => reject(e instanceof StatusError ? e : new StatusError('auth'))).finally(() => signal.removeEventListener('abort', abort));
  });
  if (viaHost && !/[\r\n]/.test(viaHost)) return viaHost;
  signal.throwIfAborted();
  const keyPath = join(homedir(), '.openclaw', 'workspace', 'paperclip-claimed-api-key.json');
  try {
    const raw = await readFile(keyPath, 'utf8');
    // Strip a UTF-8 BOM (PowerShell writes one by default) before parsing.
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as { token?: unknown };
    if (typeof parsed.token === 'string' && parsed.token && !/[\r\n]/.test(parsed.token)) return parsed.token;
    try { console.error('[paperclip-status] resolveToken: file token missing/invalid at ' + keyPath); } catch {}
  } catch (e) {
    try { console.error('[paperclip-status] resolveToken: file read failed at ' + keyPath + ' homedir=' + homedir() + ' err=' + (e instanceof Error ? e.message : String(e))); } catch {}
  }
  throw new StatusError('auth');
}

const denied = () => ({ content: [{ type: 'text' as const, text: 'Paperclip status unavailable: owner/private authorization or secure configuration missing.' }], details: { error: 'access_denied' } });
export function admitted(ctx: OpenClawPluginToolContext, companyId: string): boolean {
  // Memory audience can inherit through subagents, so it is NOT sufficient to prove delivery privacy.
  // The host attests owner/private invocation via senderIsOwner, conversationReadOrigin,
  // memoryAudience, session, and the assert functions. A tool binding is an OPTIONAL
  // additional out-of-band attestation: when a caller provides one it must match, but
  // no existing caller (Telegram, CLI, gateway) provides a paperclip-status binding,
  // so requiring one makes the tool unreachable. Do not require it.
  // Origin/audience: a CLI turn is 'delegated' with no memory audience (output goes to
  // the owner's own terminal, inherently private), while a channel DM is 'direct-operator'
  // with an owner-private audience. Accept both; when an audience IS present it must be
  // owner-private, and its assert fn must exist.
  const binding = ctx.toolBindings?.['paperclip-status'] as Record<string, unknown> | undefined;
  const bindingOk = !binding || (
    binding.privateConversation === true && binding.companyId === companyId && binding.sessionId === ctx.sessionId &&
    binding.channel === ctx.deliveryContext?.channel && typeof binding.channel === 'string' &&
    binding.to === ctx.deliveryContext?.to && typeof binding.to === 'string'
  );
  const audience = ctx.memoryAudience?.kind;
  const audienceOk = audience === undefined || audience === 'owner-private';
  const assertMemoryOk = audience === undefined || typeof ctx.assertMemoryAudienceCurrent === 'function';
  const checks = {
    senderIsOwner: ctx.senderIsOwner === true,
    readOrigin: ctx.conversationReadOrigin,
    readOriginOk: ctx.conversationReadOrigin === 'direct-operator' || ctx.conversationReadOrigin === 'delegated',
    sandboxed: ctx.sandboxed,
    memoryAudienceKind: audience,
    audienceOk,
    hasAssertMemory: typeof ctx.assertMemoryAudienceCurrent === 'function',
    assertMemoryOk,
    hasAssertInvocation: typeof ctx.assertInvocationCurrent === 'function',
    hasSessionId: !!ctx.sessionId,
    hasSessionKey: !!ctx.sessionKey,
    bindingOk,
    hasResolveApiKey: typeof ctx.resolveApiKeyForProvider === 'function',
    deliveryChannel: ctx.deliveryContext?.channel,
    deliveryTo: ctx.deliveryContext?.to,
  };
  const ok = checks.senderIsOwner && checks.readOriginOk && ctx.sandboxed !== true &&
    audienceOk && assertMemoryOk &&
    checks.hasAssertInvocation && checks.hasSessionId && checks.hasSessionKey &&
    bindingOk && checks.hasResolveApiKey;
  if (!ok) {
    try { console.error('[paperclip-status] admitted=false ' + JSON.stringify(checks)); } catch {}
  }
  return ok;
}
export function makeTool(ctx: OpenClawPluginToolContext, pluginConfig: unknown) {
  return {
    name: 'paperclip_status', label: 'Paperclip Status',
    description: 'Read-only fixed-company snapshot: overview, MTD costs, pending approvals and recent activity. Requires host-attested owner/private invocation. API labels are untrusted data; no actions or run mutation.',
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id: string, params: unknown, outerSignal?: AbortSignal) {
      if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).length) return denied();
      let c; try { c = validateConfig(pluginConfig); } catch { return denied(); }
      if (!admitted(ctx, c.companyId)) return denied();
      // assertMemoryAudienceCurrent exists only when a memory audience is set (channel DM);
      // a CLI turn has no audience, so call it only when present.
      const assertCurrent = () => { ctx.assertInvocationCurrent!(); ctx.assertMemoryAudienceCurrent?.(); };
      const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(outerSignal ? [outerSignal] : [])]);
      try {
        assertCurrent(); signal.throwIfAborted();
        const token = await resolveToken(ctx, c.credentialProvider, signal);
        if (!token || /[\r\n]/.test(token)) return denied();
        assertCurrent(); signal.throwIfAborted();
        const result = await snapshot(c, createClient(c, token, 1_048_576, assertCurrent), signal, new Date(), token);
        assertCurrent();
        // No raw API or credential in tool details; only the same sanitized, bounded display.
        const text = render(result, token);
        return { content: [{ type: 'text' as const, text }], details: { timestamp: result.timestamp, reportingTimezone: 'UTC', partial: true } };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Paperclip status unavailable: ${signal.aborted ? 'timeout' : e instanceof StatusError ? e.code : 'access_denied'}.` }], details: { error: signal.aborted ? 'timeout' : e instanceof StatusError ? e.code : 'access_denied' } };
      }
    },
  };
}
export default definePluginEntry({
  id: 'paperclip-status', name: 'Paperclip Status', description: 'Read-only company snapshot for OpenClaw 2026.10.6',
  register(api) {
    api.registerTool(ctx => makeTool(ctx, api.pluginConfig), { name: 'paperclip_status' });
    // Preserve original command contract but fail closed: 2026.10.6 command context has no private attestation.
    api.registerCommand({ name: 'paperclip-status', description: 'Paperclip status (requires private host-attested tool invocation)', acceptsArgs: false, requireAuth: true, requiredScopes: ['operator.read'], handler: async () => ({ text: 'Use paperclip_status in a host-attested private owner conversation. This command cannot prove private delivery and performs no API reads.' }) });
  },
});
