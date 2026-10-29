import type { OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry';

/** Proposed plugin-owned host contract, NOT a built-in OpenClaw SDK attestation.
 * Only a trusted run initiator may mint it, after verifying the current sink.
 * assertCurrent must synchronously return true only while that exact sink is
 * private/local and the owning turn is live. JSON/tool arguments cannot mint it.
 */
export type PrivateDeliveryReceipt = Readonly<{
  version: 1;
  kind: 'owner-dm' | 'local-cli';
  companyId: string;
  sessionId: string;
  sessionKey: string;
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
  assertCurrent: () => boolean;
}>;

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
function receipt(ctx: OpenClawPluginToolContext): PrivateDeliveryReceipt | undefined {
  const value = ctx.toolBindings?.['paperclip-status'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.isFrozen(value)) return undefined;
  return value as PrivateDeliveryReceipt;
}

/** Reject explicit non-private route evidence, irrespective of inherited audience. */
function nonPrivateRoute(ctx: OpenClawPluginToolContext): boolean {
  const d: unknown = ctx.deliveryContext;
  if (d === undefined) return false;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return true;
  const route = d as Record<string, unknown>;
  if (route.isPrivate === false || route.private === false) return true;
  return ['channel', 'to', 'chatType', 'type', 'privacy', 'visibility'].some(key =>
    typeof route[key] === 'string' && /(?:^|[\s:_/-])(group|public|non-private|nonprivate|supergroup)(?:$|[\s:_/-])/i.test(route[key] as string));
}
const hasBinding = (ctx: OpenClawPluginToolContext): boolean =>
  ctx.toolBindings !== undefined && ctx.toolBindings !== null &&
  Object.prototype.hasOwnProperty.call(ctx.toolBindings, 'paperclip-status');

/** Owner decision option B: absent receipts use strict owner authorization.
 * This compatibility path is NOT positive private-destination attestation.
 * Present malformed/falsy bindings still deny rather than selecting fallback.
 */
export function admitted(ctx: OpenClawPluginToolContext, companyId: string): boolean {
  try {
    if (!nonempty(ctx.sessionId) || !nonempty(ctx.sessionKey) ||
        ctx.senderIsOwner !== true || ctx.sandboxed === true ||
        typeof ctx.assertInvocationCurrent !== 'function' ||
        typeof ctx.resolveApiKeyForProvider !== 'function' || nonPrivateRoute(ctx)) return false;
    if (!hasBinding(ctx)) {
      ctx.assertInvocationCurrent();
      return true;
    }
    const b = receipt(ctx);
    if (!b || b.version !== 1 || b.companyId !== companyId ||
        b.sessionId !== ctx.sessionId || b.sessionKey !== ctx.sessionKey ||
        typeof b.assertCurrent !== 'function') return false;

    if (b.kind === 'owner-dm') {
      const d = ctx.deliveryContext;
      if (!d || !nonempty(b.channel) || !nonempty(b.to) ||
          b.channel !== d.channel || b.to !== d.to ||
          b.accountId !== d.accountId || b.threadId !== d.threadId ||
          (b.accountId !== undefined && !nonempty(b.accountId)) ||
          (b.threadId !== undefined && !(nonempty(b.threadId) || (typeof b.threadId === 'number' && Number.isSafeInteger(b.threadId)))) ||
          ctx.memoryAudience?.kind !== 'owner-private' || typeof ctx.assertMemoryAudienceCurrent !== 'function') return false;
      ctx.assertMemoryAudienceCurrent();
    } else if (b.kind === 'local-cli') {
      // oneShotCliRun alone only marks cleanup. The receipt must additionally
      // attest actual local ingress and terminal-only output, with no channel,
      // queued or delegated completion. Nondelegation is a producer invariant:
      // conversationReadOrigin is a visibility policy, not ingress provenance.
      if (ctx.oneShotCliRun !== true || ctx.deliveryContext !== undefined || ctx.delivery !== undefined ||
          ctx.messageChannel !== undefined || ctx.nativeChannelId !== undefined ||
          b.channel !== undefined || b.to !== undefined || b.accountId !== undefined || b.threadId !== undefined ||
          ctx.memoryAudience !== undefined) return false;
    } else return false;
    ctx.assertInvocationCurrent();
    const privacy: unknown = b.assertCurrent();
    // Async receipts are invalid. Observe an accidental rejected promise without
    // emitting host exception text as an unhandled-rejection diagnostic.
    if (privacy !== true && privacy && typeof privacy === 'object') void Promise.resolve(privacy).catch(() => {});
    return privacy === true; // Reject promises, void/false and stale receipts.
  } catch { return false; }
}

/** Pin the selected path and route; recheck live authority at every effect. */
export function currentAdmission(ctx: OpenClawPluginToolContext, companyId: string): () => void {
  const supplied = hasBinding(ctx);
  const captured = receipt(ctx);
  const route = ctx.deliveryContext;
  const channel = route?.channel, to = route?.to, accountId = route?.accountId, threadId = route?.threadId;
  const sessionId = ctx.sessionId, sessionKey = ctx.sessionKey;
  return () => {
    const d = ctx.deliveryContext;
    if (hasBinding(ctx) !== supplied || (supplied && (!captured || receipt(ctx) !== captured)) ||
        ctx.sessionId !== sessionId || ctx.sessionKey !== sessionKey ||
        (d === undefined) !== (route === undefined) || d?.channel !== channel || d?.to !== to ||
        d?.accountId !== accountId || d?.threadId !== threadId || !admitted(ctx, companyId)) throw new Error('access_denied');
  };
}
