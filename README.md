# paperclip-status — SPR-7 engineering candidate

External TypeScript ESM plugin pinned to **OpenClaw 2026.10.6**, Node **24.22.1+**. No core changes, Gateway install/restart, merge or publication performed.

## Interface

`paperclip_status` is an optional, no-argument agent tool returning four deterministic sections: **overview / costs / approvals / activity**. No LLM call inside the plugin. The latest SPR-7 assignment intentionally adds activity despite the earlier SPR-2 draft excluding it.

The original `/paperclip-status` registration uses `requireAuth: true`, `requiredScopes: ["operator.read"]`, and `acceptsArgs: false`. **Its handler denies API access** because the 2026.10.6 command context does not prove private delivery. It does not silently fall back to weaker sender allowlist authorization. This candidate is **not full command/chat acceptance**.

## Read contract and limitations

Only these fixed-company GET paths are possible at runtime:
- `/api/companies/{companyId}/agents`
- `/api/companies/{companyId}/costs/summary?from=...&to=...`
- `/api/companies/{companyId}/costs/by-agent?from=...&to=...`
- `/api/companies/{companyId}/approvals?status=pending`
- `/api/companies/{companyId}/activity?limit=10`

**No issue-runs requests**: the source-documented GET can write liveness backfill. `normalizeIssueRuns` only verifies the source shape in synthetic tests (`runId`, not `id`) and is not used by the snapshot. Company heartbeat-runs was not live-verified; this candidate does not call it. Overview retains all returned agents up to 100 and labels **latest run unknown**, not idle/no-run. Thus roster-wide latest-run acceptance remains unresolved, not falsely complete.

Costs share an explicit inclusive UTC month-to-date interval, from month-start to invocation snapshot. Exact decimal cents are preserved. Unless the operator verifies and sets `currency`, display is **cents (currency unconfirmed)**. Two independent requests are not atomic, and totals are not engineer/sprint spend. Missing per-agent cost rows are unknown, never zero. Pricing/estimated/unpriced/pending accounting indicators are shown; unavailable fields stay unknown. Actor-scoped lists never claim global completeness. Approvals omit payload; activity omits details and is not run/cost authority.

Maximum concurrency 4; overall tool deadline 15s; at most one retry per read for network/5xx/429, honoring Retry-After. No retry for 401/403. Lists have no invented cursors; 100-row display caps and explicit omitted counts. Per-response cap 1 MiB before JSON parse; deterministic total text cap 3600 chars with all four headings and output omissions. Selected raw API strings are credential-redacted before field truncation, strip controls/bidi/platform markup/@ mentions and are labeled untrusted data. Only sanitized display content and small non-secret metadata leave the tool.

## Secure admission (deployment gate)

**Owner decision 2026-10-29, option B supersedes the earlier receipt-required gate.** When `toolBindings["paperclip-status"]` is absent, the tool admits only owner=true, nonempty sessionId/sessionKey, non-sandboxed context, supported host credential resolution, and a passing live invocation authority callback. Explicit group/public/non-private route evidence denies, including delegated contexts and inherited owner-private audiences. Owner CLI turns with oneShotCliRun and no route/audience/receipt now succeed. Neither inherited memory nor read visibility is treated as destination proof. This compatibility path is **strict owner authorization, not a guarantee of private delivery**; ambiguous routes can lack group evidence. MVP merge decisions remain separate.

When a host supplies a binding, it must be a fresh, frozen `PrivateDeliveryReceipt` (exported from `dist/admission.js`). Present null/false/undefined/malformed bindings deny, rather than switching to the absent-binding compatibility path. This is a proposed plugin-owned contract, not a built-in SDK feature; this package does not mint it. The existing validated receipt paths retain matching company/session/route, supported credential resolution and live invocation authority:

- **owner-dm:** version=1, kind=`owner-dm`, exact channel/to/accountId/threadId, current owner-private memory audience and its live guard. Channel names, recipient strings, read origin and inherited memory are NOT privacy attestations.
- **local-cli:** version=1, kind=`local-cli`, oneShotCliRun=true, no deliveryContext (even an empty object), outbound delivery capability, message/native channel, receipt route or inherited memory audience. The producer must independently verify local process ingress and terminal-only output: no delegated child output, queued/channel completion or `--deliver`. The cleanup flag alone is insufficient.
- **both:** receipt `assertCurrent(): boolean` must be a synchronous, host-owned closure that returns exactly true only while the owning turn and the **actual current output destination** remain private/local and bound to the admitted owner. It must revoke on route/account/thread/session changes, turn closure, destination privacy changes and deferred/delegated output redirection. Never use a constant-true callback in production, mint it from JSON/model arguments or inherit it through spawn lineage. The fixture callbacks are test doubles only.

Present null/false, old boolean-only, unfrozen, malformed, stale or mismatching receipts deny before credentials/HTTP. Selected path, receipt identity (when supplied), session and route fields are pinned per execution; a binding cannot be added/removed/swapped to reauthorize an in-flight call. The selected authorization gate is checked before/after credentials, before every dispatch after DNS/backoff, and after rendering before disclosure. Supplied receipts retain live privacy/memory checks. Receipt-less calls retain live owner/authority and explicit group/public denial, but do not invent a privacy attestation. `conversationReadOrigin` is only a conversation-read visibility policy.

Host evidence on OpenClaw **2026.10.6**: `dist/config-contracts-C65kIjn4.d.ts` exposes out-of-band toolBindings, route, oneShotCliRun and authority callbacks, but no built-in current private-destination receipt. `dist/agent-command-execution-identity-BwI0hUnw.mjs` clears toolBindings on public ingress; `dist/agent-via-gateway-BVVff6W4.mjs` sets oneShotCliRun on local runs while carrying dispatch options. A trusted producer is needed only for the optional receipt path, not for receipt-less owner CLI compatibility. Approved managed-host tests remain necessary to establish actual delivery behavior. See `docs/SPR-12-v1.1.md` for current acceptance and residual-risk boundaries; `docs/SPR-12-verification.md` is historical.

Credentials use the selected host auth-profile provider first. Only **strictly undefined** may reach an optional development file; invalid/empty/whitespace/CRLF/nonstring host keys and synchronous/asynchronous resolver failures never switch identities. The automatic global claimed-board-key fallback is removed. No profile or credential file is created and no supplied token is copied into this repository.

Development file fallback is **off by default**. It requires `allowDevelopmentCredentialFallback: true`, `allowLoopbackDevelopment: true`, an absolute `developmentCredentialFile`, and a literal loopback base URL. File JSON must be `{ "version": 1, "companyId": "<matching UUID>", "credentialProvider": "<matching provider>", "token": "<operator-provisioned key>" }`; legacy unscoped token-only files deny. Metadata matching is not proof of server-enforced least privilege: provision a company/provider-scoped key, not an unrestricted board key.

The reader is POSIX-only: owner-private regular file, no writable/symlink directory ancestors, no-follow/nonblocking descriptor open, matching inode/device, and a 16KiB cap enforced against actual bytes (including growth after stat). Host resolution and filesystem operations race the invocation abort signal; late opened handles close safely. The selected admission path is rechecked before/after async steps and before parsing/output. File/parse/permission errors emit only fixed auth/access_denied/timeout categories—no paths, parser source or recipient diagnostics. **Windows fallback is disabled without an actual ACL verifier**; use the supported host profile instead. POSIX filesystem assertions in this Windows checkout are synthetic, not a native deployment audit.

## Operator-owned configuration

```json
{
  "baseUrl": "https://paperclip.example.com",
  "companyId": "03b0ee80-f106-475e-bc61-8c226ceda184",
  "credentialProvider": "paperclip"
}
```

Only origin URLs are accepted: no credentials, path/query/fragment or model-provided URL. Plain HTTP requires `allowLoopbackDevelopment: true` and literal `127.0.0.1` or `::1`. This is a **local development exception**; a service on that port can receive the credential. Dedicated HTTP/HTTPS agents disable environment-proxy routing. HTTPS public-address resolution rejects private/reserved answers, validates all answers, and pins the actual connection lookup (including Node 24 all-address mode) to prevent DNS rebinding; redirects are never followed. The conservative IPv6 policy permits only 2000::/3, excluding 2001::/23 protocol assignments (including some routable exceptions deliberately), 2001:db8::/32 documentation, legacy 2002::/16 6to4 and RFC 9637 3fff::/20 documentation; translation, mapped, discard, ULA, link-local and SRv6 special-use prefixes outside 2000::/3 also deny. Hextet parsing covers case, leading zeros and compression; exact prefix-boundary tests are included. This policy may deny legitimate special-purpose endpoints. Operators must secure DNS/proxy/TLS and network egress; no claim of defending against a compromised local host. Never configure from untrusted input. Production deploy requires independent Security review.

## Development and package verification

```sh
npm ci --ignore-scripts --legacy-peer-deps
# Provide the exact OpenClaw 2026.10.6 peer on an isolated development host.
npm run typecheck
npm test
npm pack --dry-run
```

`dist/index.js` is the published runtime entry; runtime dependency `typebox` is pinned; TypeScript/@types/node are dev-only. `private: true` prevents accidental npm publication pending maintainer decision. Local SDK development uses a node_modules junction to the already-installed exact host package; no core files are edited. Node `>=24.22.1` is declared in package/lockfile. `.github/workflows/ci.yml` runs typecheck and the full tests on PRs against main, with exact SDK/Node versions, SHA-pinned actions, read-only contents permission and no dependency lifecycle scripts. Local fixture checks do not prove an actual GitHub Actions run. SDK register/invoke fixtures do not count as managed plugin install or actual trusted chat smoke. No source-only/tarball install on the running Gateway is authorized here.

## Delivery gates

Canonical repository: https://github.com/alenpros2010/paperclip-status, base `main`. The latest SPR-12 scope consolidates TD-SEC-01/02/03 and TD-1/2/3 on `fix/tech-debt-v1-1`, starting from merged PR #2 (`a40770d`), for the requested PR #3. No new issues are created. Earlier `fix/current-private-delivery` evidence is historical; the v1.1 verification supersedes its counts/artifact. PR delivery is requested but the current agent's GitHub connection is unavailable. No push/PR, Gateway install/restart, core modification, merge or publication has yet occurred. See `docs/SPR-12-v1.1.md` for the six-item matrix and current delivery gates.

Independent Security review, approved managed-host integration smoke and maintainer deployment approval remain distinct. Trusted receipt production is optional under option B, not a blocker for receipt-less owner admission. The SPR-12 issue must not be marked complete from synthetic tests. Existing command denial is unchanged.

Research basis: `research-synthesist/SPR-3/{contract.md,PAPERCLIP-STATUS-PLUGIN-SPEC.md}`, live update run 84c7b07a (4/5 endpoints; issue-runs skipped), upstream Paperclip snapshot `6336c340411809b3a94af1f4a911b30c0275447c`. Nonempty approvals, global visibility, deployed currency and latest-run coverage are not established by the empty/synthetic fixtures.
