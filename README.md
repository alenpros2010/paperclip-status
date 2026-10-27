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

A trusted host integration must supply **all** of the following, out of band, not in tool arguments:
- `senderIsOwner === true`; `conversationReadOrigin === "direct-operator"`; not sandboxed;
- host `memoryAudience.kind === "owner-private"`, with live `assertMemoryAudienceCurrent` and `assertInvocationCurrent` callbacks;
- current `sessionId`, `sessionKey`, and delivery context;
- `toolBindings["paperclip-status"]` containing `{ privateConversation: true, companyId, sessionId, channel, to }`, matching this invocation and its actual private delivery route;
- supported `resolveApiKeyForProvider(credentialProvider)` callback.

The SDK declares `toolBindings` as an out-of-band plugin-owned binding attached by the run initiator. **This package does not mint or populate that attestation.** A host integration must prove the current destination is private and re-establish bindings for each turn. A memory audience alone is insufficient: source `memory-audience-DhRR-m6C.mjs` inherits through spawn lineage and may describe the root, not the current delivery route. Delegated/unknown origin, missing evidence, group routes or stale authority deny before credential/API access. Authority is rechecked immediately before each HTTP dispatch (after DNS/backoff, including retries/dependent reads) and before output. Required private binding provisioning and an actual host/chat smoke are still Security/deployment gates.

Credentials are resolved from the host's supported auth-profile callback, not a token in plugin config/chat. **No profile is created automatically.** The operator must configure an appropriately scoped Paperclip profile and validate that the credential is intended for this fixed company. The supplied claimed file is used only by the separate, user-authorized engineering API/probe scripts; it is never copied into the plugin/repo/fixtures. Generic SecretRef support is not claimed.

## Operator-owned configuration

```json
{
  "baseUrl": "https://paperclip.example.com",
  "companyId": "03b0ee80-f106-475e-bc61-8c226ceda184",
  "credentialProvider": "paperclip"
}
```

Only origin URLs are accepted: no credentials, path/query/fragment or model-provided URL. Plain HTTP requires `allowLoopbackDevelopment: true` and literal `127.0.0.1` or `::1`. This is a **local development exception**; a service on that port can receive the credential. Dedicated HTTP/HTTPS agents disable environment-proxy routing. HTTPS public-address resolution rejects private/reserved answers, validates all answers, and pins the actual connection lookup (including Node 24 all-address mode) to prevent DNS rebinding; redirects are never followed. Conservative IPv6 rejection may deny legitimate endpoints. Operators must secure DNS/proxy/TLS and network egress; no claim of defending against a compromised local host. Never configure from untrusted input. Production deploy requires independent Security review.

## Development and package verification

```sh
npm ci --ignore-scripts --legacy-peer-deps
# Provide the exact OpenClaw 2026.10.6 peer on an isolated development host.
npm run typecheck
npm test
npm pack --dry-run
```

`dist/index.js` is the published runtime entry; runtime dependency `typebox` is pinned; TypeScript/@types/node are dev-only. `private: true` prevents accidental npm publication pending maintainer decision. Local SDK development uses a node_modules junction to the already-installed exact host package; no core files are edited. SDK register/invoke fixtures do not count as managed plugin install or actual trusted chat smoke. No source-only/tarball install on the running Gateway is authorized here.

## Delivery gates

The authenticated SPR-7 issue and parent have **no repository, project workspace or target base branch**; company projects returned empty. GitHub identity check reports credentials unavailable, no Git author/account. Work therefore lives in this **staging directory**, not a substitute canonical repo. Do not initialize an arbitrary upstream or claim an opened PR.

To open the requested PR: operator supplies repo + base branch and connects GitHub in **Settings → Agents → Tools**. Import this candidate on a feature branch, run CI, and open PR; retain independent Security Reviewer, fixes/re-review, Content fact-check, maintainer merge and publication gates. No self-approval. Engineer budget ceiling $40; actual attributable cost has not been verified, and company MTD is not used as task cost.

Research basis: `research-synthesist/SPR-3/{contract.md,PAPERCLIP-STATUS-PLUGIN-SPEC.md}`, live update run 84c7b07a (4/5 endpoints; issue-runs skipped), upstream Paperclip snapshot `6336c340411809b3a94af1f4a911b30c0275447c`. Nonempty approvals, global visibility, deployed currency and latest-run coverage are not established by the empty/synthetic fixtures.
