# SPR-12 private-delivery admission — historical first candidate

Superseded for current scope by `SPR-12-v1.1.md`. This records the earlier TD-1-only candidate; its fallback behavior, branch, counts and artifact are historical, not the v1.1 deliverable.

## Scope and gates

Source: SPR-11 audit of PR #2, head `0d1b03a481fa7ff2444ca5a4cf4e0e0785166c24`. Work starts from canonical `main` commit `a40770d` (merged PR #2) on local `fix/current-private-delivery`.

This is non-blocking MVP tech debt, not a dependency or approval change for the original PR. No push/PR, host install/restart, core changes, merge or publication are performed. Proposed receipt contract lives in `src/admission.ts`; no trusted host producer exists in this candidate.

## Implementation acceptance matrix

| Requirement | Candidate evidence | Managed-host evidence |
| --- | --- | --- |
| Missing-binding group denies before secrets/HTTP/disclosure | Admission tests count resolver calls and loopback HTTP reads: zero | Not run |
| Delegated non-CLI, inherited owner audience on group deny | Explicit absent-binding/group cases | Not run |
| Null/false/malformed binding denies | Missing, undefined, null, false, zero, empty string, arrays, object, unfrozen and old receipt cases | Not run |
| Owner, sandbox, session and live authority retained | Existing suite plus stale invocation/memory cases | Not run |
| Route changes / stale receipts deny | Channel/to/account/thread changes during resolver; receipt replacement; live privacy revocation | Not run |
| Rechecks before every credential source | Host resolver result then guard before fallback readFile; fake builtin read spy proves zero reads on stale undefined result | Not run |
| Retry/dependent reads and final output deny when privacy changes | Privacy revocation on 503 / summary; all-five-reads final disclosure suppression | Not run |
| Verified owner DM succeeds | Frozen host-contract fixture + five synthetic GETs | **Unverified: fixture is not host attestation** |
| Genuinely local CLI succeeds | Explicit terminal-only fixture; route/capability/memory/cleanup-invalid cases deny | **Unverified: no producer verifies ingress/output** |

CLI nondelegation must be verified by the producer's current-sink/provenance closure. `conversationReadOrigin='delegated'` is compatible with a genuinely local CLI read-visibility policy; it cannot prove an actual delegated child. Tests show the proposed callback denies actual delegated-completion provenance and allows a local receipt with delegated read visibility. Never use constant-true test callbacks in production.

## Review and fixes

Independent read-only review found a stale fallback-secret read and malformed host credentials falling through to a different identity. Both fixed: pinned admission checked after host resolution and immediately before/after file access; fallback only for strictly undefined host keys. Empty/whitespace/CRLF/nonstring host results fail auth with zero fallback reads. File/parse errors emit constant failures; malformed synthetic secret-bearing JSON produces no diagnostics. BOM-prefixed fallback JSON is covered without accessing the real credential file.

Review also highlighted CLI nondelegation: it is now documented as a required trusted producer invariant, not incorrectly inferred from read origin. This review is engineering evidence, not the separate Security/deployment approval.

## Managed-host applicability and concrete unresolved gate

Live `openclaw status` reported Gateway reachable, app **2026.10.6**, Node **24.22.1**, Telegram enabled. This is host health/version evidence only; no sensitive status invocation or receipt injection was attempted.

Installed SDK evidence:
- `dist/config-contracts-C65kIjn4.d.ts:40567–40646`: out-of-band toolBindings; ambient delivery route; owner/memory and invocation callbacks; read origin explicitly restricted to conversation-read policy; oneShotCliRun described as resource cleanup.
- `dist/system-events-Dhr177RD.d.ts:64–75`: delivery route includes channel/to/accountId/threadId and queued intent.
- `dist/agent-command-execution-identity-BwI0hUnw.mjs:58–63`: public ingress clears toolBindings.
- `dist/agent-via-gateway-BVVff6W4.mjs:697–706`: local CLI carries dispatch options while setting oneShotCliRun; flag alone is not sink privacy.

**Blocked acceptance:** a supported trusted host producer must attest the actual current private destination / truly local terminal-only ingress and revoke on turn, route, privacy, session and completion changes. It must attach immutable callback-bearing receipts through supported runtime ingress, not JSON RPC/model arguments or inherited audiences. Current stock calls intentionally deny with this candidate. The original parent scope says no core changes; changing the running host or expanding that scope needs owner direction.

Recommended next scope: approve a disposable managed-host integration environment and a supported host-owned receipt producer (or supply an existing supported attestation API). Then run real owner-DM/local-CLI successes and group/missing-binding/inherited/delegated/stale-route failures with instrumented secret/HTTP/output counts. Retain independent Security and maintainer deployment approvals. Until then SPR-12 is not complete and the running plugin is unchanged.

## Reproducible local checks

`npm ci --ignore-scripts --legacy-peer-deps`; isolated junction to installed exact SDK; `npm run typecheck`; `npm test`; `git diff --check`; `npm audit --omit=dev --legacy-peer-deps`; `npm pack --json --pack-destination ../artifacts`.

Final observed counts, command exits, package file list / SHA-256 and isolated archive entry-load proof are recorded alongside the checkout in `../verification.json`, `../tests.log`, `../pack.json`, `../package-check.json`. Archive/fixture validation is distinct from managed installation. The task API credential is used only by bounded authenticated task reads/reporting, held in process memory, never fixtures/source/build/package. No snapshot reads against the real company are required for this admission change.
