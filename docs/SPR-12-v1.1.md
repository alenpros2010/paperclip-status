# SPR-12 v1.1 — six-item delivery round

Authoritative scope: updated SPR-12 description revision `0a25cccf00ee8c1d029ed002f2a9ab191eeba70d25ffc623596470042cabb3a7`, including **owner decision 2026-10-29 option B**, superseding mandatory receipts;  plus original SPR-11 audit comment `fe428fe4-5c37-4945-b39c-e7dcd4e37117` for TD-2/TD-3 omitted from the abbreviated issue description. No new issues created; all six changes belong to requested `fix/tech-debt-v1-1 -> main`, intended PR #3. Canonical base starts at `a40770d` (merged PR #2).

## Acceptance matrix

| Item | Implementation / evidence | Remaining acceptance |
| --- | --- | --- |
| TD-SEC-01 — labels as data | `dataLabel()` JSON-quotes sanitized strings with explicit `label:` prefix; overview/costs injection-style names and escaped quote/newline tests; selected raw strings redacted before truncation | Local checks only; no claim quoting eliminates every prompt-injection risk |
| TD-SEC-02 — special-use IPv6 | Parse validated IPv6 hextets; exact 3fff::/20 denial and both prefix boundaries; retain 2001:db8 and mapped denial; conservatively exclude 2001::/23 and 2002::/16 | Policy intentionally denies routable exceptions inside 2001::/23; no exhaustive future-registry/routing claim |
| TD-SEC-03 — Node + CI | engines.node >=24.22.1 in package/lock; PR workflow typecheck/test; exact SDK and Node; read-only contents; SHA-pinned checkout/setup-node verified by live ls-remote | GitHub Actions execution/PR not yet available |
| TD-1 — owner decision option B | Absent binding uses strict owner/nonempty session/non-sandboxed/live authority/host resolver checks; owner CLI without receipt succeeds; explicit group/public/non-private routes deny independently of inherited audience/read origin. Present receipts retain validation and live privacy. Path/route/session are pinned and rechecked before credentials, dispatch, retries and output; async receipt rejection remains non-disclosing | Receipt-less authorization does not attest privacy of ambiguous destinations. Local fixtures are not live VPS acceptance; trusted receipt production is no longer a prerequisite for compatibility |
| TD-2 — nonsecret diagnostics | No serialized admission/recipient context or raw parser/file/exception messages; constant auth/access_denied/timeout; mocked malformed/missing/absent/null/nonstring/CRLF/BOM tests, generic public tool response and zero HTTP | No real malformed credential or operator file was touched |
| TD-3 — scoped fallback and cancellation | Host-first, strictly undefined-only; explicit default-off loopback development config; fixed metadata version/company/provider; private POSIX regular file with ancestor/no-follow/descriptor checks; max 16KiB+1 bounded actual read; abort-raced IO, late-handle cleanup; Windows denies absent verified ACL | POSIX assertions are synthetic on Windows; native deployment permissions/token least-privilege audit remains operator/Security-owned |

## Credential provision contract

Production uses the selected supported host auth profile; do not configure a token in plugin config. Development fallback is opt-in only with `allowDevelopmentCredentialFallback: true`, `allowLoopbackDevelopment: true`, an absolute `developmentCredentialFile`, and a literal loopback base URL. Provision private POSIX directories/file, never world/group writable or symlink ancestors. File metadata must contain `version:1`, the exact `companyId`, exact `credentialProvider`, and nonempty no-CRLF `token`. The plugin does not provision this file, fix permissions, or reuse the global claimed board key. Windows fallback intentionally denies until a real ACL verifier is supported.

Task-service reporting still uses the user-designated claimed-key file separately in process memory; it is not plugin fallback or repository material. No real company snapshot was requested by the test harness; API/transport fixtures use synthetic credentials and ephemeral local servers.

## IPv6 evidence

IANA IPv6 Special-Purpose Address Registry fetched 2026-10-28 (registry last updated 2025-10-09): https://www.iana.org/assignments/iana-ipv6-special-registry/ . RFC 9637 marks 3fff::/20 as non-destination/non-forwardable/non-global documentation space. 2001::/23 contains protocol assignments, 2001:db8::/32 is documentation, 2002::/16 is legacy 6to4 with embedded IPv4 reachability concerns. The conservative 2000::/3 allow policy already denies mapped/translation/discard/SRv6/ULA/link-local prefixes outside it. Registry data does not guarantee routeability; broader routable protocol exceptions are deliberately not enabled.

## Verification boundaries and delivery

The revised option-B command exits, full-suite counts, archive/hash, extracted checks, complete patch and token scan are in sibling `option-b-verification.json`, `option-b-tests.log`, `option-b-pack.json`, `option-b-package-check.json`, `option-b-candidate.patch` and `option-b-artifacts/`. These supersede both the 97-test first candidate and 196-test mandatory-receipt v1.1 candidate. `.github/workflows/ci.yml` is statically inspected locally, not a recorded GitHub Actions run. No working tree on the live Gateway, core file, config, startup service, or installed plugin has been modified.

GitHub identity live-check: agent connection unavailable; no effective account/author/repository grants. Connect GitHub for this agent under Settings -> Agents -> Tools, or explicitly select an operator-owned patch publication path. PR creation is requested, not refused on permission grounds; no credential substitute is searched for or copied.

Installed plugin inventory previously reported paperclip-status enabled at 0.1.0; that does not prove this revised candidate is loaded. The current Paperclip issue route is not independent evidence of a private sink. Option B explicitly authorizes softer owner-only admission in the staging code; the absent host receipt producer is **no longer an implementation blocker**. The earlier question about mandatory receipt production is obsolete and must be withdrawn/replaced with only remaining access/test-route inputs.

Actual live VPS acceptance still requires an approved owner-private managed test route and a way to load this candidate without unauthorized live Gateway/core changes or restart. Do not invoke an older installed plugin and label it verification of the revised candidate. Fixture successes are not VPS verification. The parent's no-core-change requirement and independent Security, maintainer merge/publication/deployment gates remain. This is non-blocking MVP debt, not a parent merge dependency. PR/live acceptance remains incomplete. Ambiguous receipt-less delivery remains a consciously accepted policy limitation under option B, not a private-destination proof.
