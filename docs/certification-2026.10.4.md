# PM CLI/SDK 2026.10.4 certification

Owner: [pm-todos-zpyc](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/chores/pm-todos-zpyc.toon).

Development pins: `@unbrained/pm-cli`, `pm-ops`, `pm-changelog` 2026.10.4;
`@types/node` 26.6.4; TypeScript 7.0.2. The supported host floor remains
2026.8.20. The managed GitHub extension and CI restoration use pm-github
2026.10.4. Dependabot #104's CodeQL init/analyze SHA is copied exactly:
`2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2` (`# v4`).

The canonical launcher was copied unchanged from the installed
`pm-ops/templates/prepare-merge-driver.ts`. Its byte-identity test failed before
refresh and the launcher suite passed 7/7 afterward. CLI 2026.10.4 refuses
incomplete local-directory installs; the three affected behavioral fixtures now
install this checkout's packed distribution. Their behavioral assertions are
preserved; the focused integration/import tests passed 5/5 with zero skips.

Both `npm audit --omit=dev` and `npm audit` report zero vulnerabilities; the
repository has no open Dependabot security alerts. `npx pm health --strict-exit
--require-merge-drivers` passed. The read-only `npx pm github import
unbraind/pm-todos --state all --atomic --dry-run` preview found two existing
issues and proposed 0 imports, 2 tracker updates, 0 skips, with no writes.
The scheduled sync remains disabled.

The test stage of the full gate passed 280/280 tests with zero skips and measured 97.87% lines,
93.33% branches and 98.46% functions across its one configured source file.
Its packed scenarios additionally isolate PM_PATH from the invoking linked-test
runner. The final `flock /tmp/claude-1000/heavy-gate.lock npm run release:check`
passed via `npx pm test pm-todos-zpyc --run --only-index 3 --progress
--pm-context tracker --override-linked-pm-context`, including canonical-reader,
production audit, pack, all four packed current/minimum npm/Bun scenarios,
changelog, date and publish-attestation checks. Existing coverage thresholds remain 97% lines,
93% branches and 98% functions; no separate statement metric is enforced.

Real-data dogfood copied this repository's `.agents/pm` into disposable
`pm-todos-dogfood/.agents/pm`, packed the package with `npm pack
--pack-destination <scratch>/pack`, and installed its tarball with `npm install
--ignore-scripts @unbrained/pm-cli@2026.10.4 <tarball>` and `npx -y
@unbrained/pm-cli@2026.10.4 package install <tarball> --project`. For each of
`npx -y @unbrained/pm-cli@2026.10.4` and `bunx --bun
@unbrained/pm-cli@2026.10.4`, the exact command suffixes were:

```sh
--version
--json todos export --format jsonl --output <scratch>/real-<launcher>.jsonl
--json todos import <scratch>/real-<launcher>.jsonl --format jsonl --upsert --dry-run
--json todos import <scratch>/real-<launcher>.jsonl --format jsonl --upsert
```

Both hosts reported 2026.10.4; both exported 83 real items, previewed 0 imports /
83 updates / 0 skips, and applied 0 imports / 83 updates / 0 skips inside scratch
only. Both exported files contained 83 parseable JSONL rows. All commands exited
0. The scratch copy was deleted afterward. This establishes command operation
on the real tracker; rich-field fidelity remains covered separately by the
integration fixture. All heavy commands held the shared host lock.
