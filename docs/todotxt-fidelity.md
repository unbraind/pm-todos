# Issue #108: todo.txt fidelity evidence

The baseline is main at `d14c7df` (`pm-todos@2026.10.5`). After `npm ci` and
`npm run build`, the public built exports reproduce the issue:

```js
import { parseTodoTxtLine, todoTxtItemToPm, serializeTodoTxtLine } from './dist/index.js';
const source = parseTodoTxtLine('x 2026-10-02 2026-10-01 Fixture task +project @ctx');
console.log(serializeTodoTxtLine(todoTxtItemToPm(source)));
// x 2026-10-02 2026-10-01 Fixture task +project +ctx
```

Passing `'fidelity'` as the third argument to `todoTxtItemToPm` and the second
argument to `serializeTodoTxtLine` instead returns the original line, retaining
`+project @ctx`. CLI import, export and sync expose this same policy through
`--todotxt-mapping fidelity`. Default `tags` mode remains compatible and lossy.

The `todos_todotxt` extension field retains source provenance. Ordered source
body tokens preserve project/context spelling, same-name pairs, duplicates,
Unicode, and interleaved text and metadata. Existing namespaced fields retain
creation/completion dates and key:value metadata. Export reflects current PM
edits; generic added tags become projects. Whitespace and row ordering limits,
case-insensitive tag removal, and priority fallback are documented in README.
JSONL also carries this provenance; sparse Markdown output remains unchanged.

`test/todotxt-fidelity.test.ts` checks 312 deterministic generated lines across
open/completed rows, priorities A–Z or absent, dates, multiple and duplicate
projects/contexts, arbitrary key:value tags, interleaving and Unicode. It also
packs and installs the built extension into a disposable real PM tracker,
then exercises CLI import/export/sync and real SDK harness import/export/upsert
with no mocks. Compatibility, edits, unknown mapping rejection and stale field
removal are checked.

## Behavioural revert proof

Only the body of `serializeTodoTxtLine` was temporarily replaced with its body
from baseline main. Its new signature, every other implementation, and all
new tests remained in place. The original body was restored afterwards and
checked byte-for-byte; no complete source file was swapped.

- `npm run build`: exit 0 with the reverted function.
- `node --test --test-name-pattern 'fidelity SDK|fidelity persists' test/todotxt-fidelity.test.ts`:
  exit 1, two loaded tests, two assertion failures, zero skipped tests.
- The SDK assertion exported contexts as projects and moved the source tokens.
- The installed CLI assertion exported `(E) Open +shared +téléphone +研究 due:2026-11-01`
  instead of `(Z) 2026-10-01 Open @Shared +Shared @téléphone rec:1w +研究 due:2026-11-01`.
  The completed row lost context distinction, dates, priority and key:value tags.
- Restored implementation: all four fidelity tests pass, including the real
  installed-package round-trip and generated cases.

## PM peer gap

The pinned PM CLI/SDK rejects `update --unset priority`. Fidelity maps missing
priority to numeric default `2` and omits its marker while unchanged. Re-import
without priority resets that default. The local follow-up is `pm-todos-9pyr`;
no upstream issue was filed.

## Release gates

Both `npm run release:check` and `bun run release:check` exited 0 on the final
implementation. Each ran 289 tests with zero failures or skips, and reported
97.92% lines, 93.92% branches and 98.50% functions for `index.ts`, exceeding the
unchanged thresholds of 97/93/98. These scripts execute Node's test runner;
the command names do not imply native Bun test coverage.

Both gates also passed typechecking, docstrings, the canonical-reader test,
production audit (zero vulnerabilities), dry-run packing, changelog consistency,
release-date verification, and publish-attestation verification. Their packed
acceptance matrix passed npm-current, bun-current, npm-minimum and bun-minimum
with PM versions `2026.10.4` and `2026.8.20`. No publication was performed.
The built package archive had SHA-1 `93b42581ad300615fa1f07c05494df4eb22590f8`
in both gates.

`pm test pm-todos-3nss --run --progress` also passed the linked command
`node --test test/todotxt-fidelity.test.ts` (four tests). The tracker has result
tracking disabled, so this receipt is recorded here and in the item comments.
`npm run changelog:full` was regenerated after tracker writes.

## PR #110: ambiguous title signatures

The built, packed extension reproduced silent row loss using two scratch
trackers and the public CLI. With `Task +one` and `Task @two` as input,
`pm todos sync todo.txt --format todotxt --todotxt-mapping tags` reported
`imported=1, updated=1, skipped=0, reexported=1` and wrote `(C) Task +two`.
The same command with `--todotxt-mapping fidelity` wrote `Task @two` with
identical counts. Both successful commands replaced two source rows with one.

Upsert now parses and filters every input file before mutations. It rejects
repeated fallback signatures among incoming rows without embedded ids and
signatures matching more than one existing item. The existing signature index
retains every candidate instead of silently keeping the first. Refusals include
source file:line locations, existing ids where applicable, and recovery advice.
Embedded ids use exact matching; a missing id never falls back to a title match.
Dry-run performs the same checks. Plain imports retain their create-every-row
behaviour. README documents the sync refusal and how to recover.

`test/ambiguous-signatures.test.ts` installs a packed artifact into real scratch
trackers and exercises public CLI commands and the source importer through the
real SDK harness. It covers both todo.txt mappings and markdown, incoming and
existing collisions, sync/import and dry-run, cross-file glob collisions,
normal create/update/sync, and exact ids on equal titles. A unique row preceding
conflicts checks that refusal happens before even unrelated writes. File bytes
and SHA-256 snapshots of every tracker file, including item history, remain
identical after refusals. Fixtures prime the host's derived metadata read caches
before snapshots; no tracker files are excluded from the comparisons.

For the behavioural revert, only the ambiguity-check block inside
`runTodoImport` was temporarily removed. All other changes and new tests stayed
in place. The reverted implementation built successfully. The command
`node --test --test-reporter=tap --test-name-pattern='incoming collision|existing ambiguity' test/ambiguous-signatures.test.ts`
exited 1: all six collision regressions failed because the CLI exited 0 instead
of refusing with exit 2. Only the omitted block was restored, and the complete
source SHA-256 matched its pre-probe value. No complete source file was swapped.

The restored implementation passed
`pm test pm-todos-3nss --run --progress --match ambiguous-signatures`: all
11 tests passed with zero failures or skips. Result tracking remains disabled;
this receipt is recorded in the item comments instead of changing that policy.

The follow-up also passed `npm run release:check` and `bun run release:check`
(exit 0 each). Both ran 300 tests with zero failures or skips, reporting
97.93% lines, 93.94% branches and 98.51% functions for the configured source
`index.ts`, above unchanged 97/93/98 thresholds. These commands use Node's test
runner. Both passed typechecking, docstrings, canonical-reader acceptance,
production audit (zero vulnerabilities), dry-run packing, changelog consistency,
release-date and publish-attestation checks. The four packed acceptance scenarios
passed on npm/Bun with current host `2026.10.4` and minimum host `2026.8.20`.
The built artifact SHA-1 was `b381c5160525d7310763453b0df3ce61b85192be` in both
runs. Changelog was regenerated after the final tracker writes. The orchestrator
verified the change independently and closed the item after
[#110](https://github.com/unbraind/pm-todos/pull/110) merged.
