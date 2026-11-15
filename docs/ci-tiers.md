# Fleet CI v2

Required checks stay `test (22.18.0)` and `test (26)`, on hosted Ubuntu, with
30-minute job limits and cancellation of superseded PRs. PRs and dispatch start
the quick tier; pushes to main start deep validation instead.

| Check | Code PR 22.18.0 | Code PR 26 | Docs/tracker PR, both | Deep 22.18.0 + 26 |
| --- | --- | --- | --- | --- |
| npm ci / merge-driver prepare / pinned pm-github install / strict health | yes | yes | yes | yes |
| Build + tests | quick | quick coverage | identity audit | full npm + Bun |
| Typecheck, docstrings | — | yes | — | full npm + Bun |
| Coverage, unchanged 97% lines / 93% branches / 98% functions | — | quick | — | full npm + Bun |
| Certified whole-corpus reader acceptance | — | yes | — | full npm + Bun |
| Production audit | — | yes | — | full npm + Bun |
| Package dry-run (README and CHANGELOG included), changelog/date | — | yes | yes | full npm + Bun |
| Six packed npm/npx and Bun/bunx consumers, minimum/current SDK | — | yes | — | full npm + Bun |
| Publish attestation verification (all tracked shebangs) | — | yes | yes | full npm + Bun |
| Bun package graph install smoke | — | yes | — | yes |
| CodeQL, separate workflow | matching paths | matching paths | executable files only | main matching paths + Monday 04:31 UTC |

There is no standalone lint, duplication or privacy script. Identity auditing
checks added lines and commit identities, including docs and tracker files.
Package dry-run builds and lists the shipped documentation. The canonical-reader
acceptance creates a synthetic tracker and does not consume repository docs.
Executable tracker and documentation files take the code path and remain
eligible for CodeQL; only their non-executable data/prose is filtered. Existing tests that create packed
fixtures remain in the Node floor test suite; there is no separate pack command
on that leg. All six packed consumers already prove Bun project/global tarball
installs and bunx host invocation; a second Bun PR release gate adds no install
path proof, so only a graph install smoke follows the npm gate.

Deep runs main pushes, dispatch and daily 02:47 UTC, away from release 03:23
and hourly reconciliation :41. Distinct `deep` checks have a 120-minute timeout,
per-ref concurrency, full depth and time scale 3. A Node × npm/Bun matrix
runs four jobs, each with exactly one full release gate. The runner expression uses
persistent local runners unless `PM_LOCAL_DEEP=off`. npm cache restoration and
Bun setup only happen on hosted runners; preinstalled local Bun is logged.

Unset depth is full. Quick uses a deterministic prefix: 50/500 model cases,
25/250 per stored-schedule seed, 25/100 per native format, and 25/200 watcher
cycles. Omitted native-format cases advance only the RNG so shortening one format
never changes the next format's original inputs or the full corpus. Cohorted 500-case models keep their first
complete 50-case cohort. Per-case assertions and operation-class checks remain;
aggregate thresholds use the generated sequence totals. No coverage threshold
or product size bound changes.

`PM_TEST_TIME_SCALE` scales only harness watchdogs and the adversarial parser
harness bound. Validation rejects invalid/nonpositive/overflowing scales before
spawning, and rounds to integer milliseconds. Mock-clock watcher deadlines and
lock-wait product inputs stay unscaled. The existing CPU-time growth-exponent
checks avoid runner descheduling and remain unchanged.

Baseline successful main run 43653601827: Node 22.18.0 execution 27m32s,
Node 26 execution 22m04s; creation-to-completion 105m36s and 117m32s. Full seeded
recurrence took 161.85s, stored schedules 105.57s, source sessions 93.53s and
hierarchy 93.04s. Quick PR wall time is pending CI. Full depth is deferred to
the deep workflow rather than rerun on an overloaded shared host.

Publish-attestation discovery examines the first line of every tracked file,
including documentation and tracker data, for a shell shebang. The existing
verifier therefore also runs on the docs path; its implementation is unchanged.

The Bun release command launches the same npm/Node test and coverage scripts.
It validates launcher compatibility; the packed acceptance consumers separately
exercise Bun installs and CLI execution. It does not certify the full suite
running on the Bun runtime.
