# Recurrence validation

The feature overlaps core scheduling only at its native deadline storage. Core
reminders/events remain the scheduling service; core defect recurrence is a
separate governance operation, and pm-gantt-chart forecasts work. The pinned SDK
and sibling sources have no todo.txt occurrence adapter or duplicate-prevention
surface. The recurrence tracker search returned no existing item. The package
keeps its SDK pin; npm reported the current CLI as 2026.10.25.

## Public corpus (read-only)

Source: public `unbraind/pm-todos`, committed `origin/main` tree
`c9fd1b426c55d28ca54da4a0cd664749f6dc1e21`. Export only `.agents/pm` with
`git archive`, extract into a plain temporary directory, make its files/directories
read-only, and compare recursive path/content SHA-256 snapshots before and after.
Do not copy an active tracker or working tree. Run SDK `listAllComplete` with
`includeBody: true`, then `previewTodoOccurrence` for each SDK-read id with and
without the dialect. Remove executables from PATH and set the git ceiling above
the temporary directory. No synthetic rows are added to this corpus.

| Measurement | Result |
| --- | ---: |
| Items read through the SDK | 99 |
| Done / active / canceled / other roles | 93 / 4 / 1 / 1 |
| Retained todo.txt source lines / recurrence tokens | 0 / 0 |
| Disabled no-ops | 99 |
| Enabled eligible occurrences | 0 |
| Enabled `invalid_source` / `not_done` refusals | 93 / 6 |
| Maximum JSON receipt size | 228 bytes |
| File/directory entries checked unchanged | 212 |
| Files changed / synthetic rows added | 0 / 0 |

This validates refusal policy and read-only behavior on natural tracker data; it
does not establish a positive natural recurrence case because none is present.
Positive creation, chaining, retries, crash recovery and concurrent CLI acceptance
use real SDK trackers with explicitly synthetic sources. The public scan exposed
65 valid legacy history tips without a record hash; their revision falls back
to a SHA-256 digest of the complete SDK-read history chain, after SDK integrity
verification, without rewriting history or reducing revisions to item content.

## Reproducible tests

`test/recurrence.test.ts` exercises SDK and packed CLI paths. The model test uses
seed `0x72656375` and 500 random sequences. Its independent reference tracker is
updated with native SDK calls; state is read back through SDK document readers,
including parent/dependency provenance, body, lifecycle, title, type, priority,
tags, due date, assignment, sprint, description and all six source fields. It
replays older inputs, varies CRLF/blank whitespace, round-trips every export
format through its importer, exercises native and legacy importer names and
sync, and checks that a predecessor still owns at most one successor. Fresh
non-git fixture copies bound history growth per sequence.

The deterministic writer test injects competing transitions at all six apply
boundaries. The source SDK lock remains owned until target publication and all
live-state checks finish; foreign records are preserved. A post-create
interruption is retried from fresh SDK state. Separate packed CLI processes
race against one plain tracker without git or pm executables on PATH.

The measured seeded run completed **813 native/legacy imports**, **419 syncs**,
**1232 explicit exports with reimports**, **722 older-input replays**, and
**633 CRLF variants** across its 500 sequences. Replacing only
`applyTodoOccurrence` with the pre-feature disabled no-op made the weekly
behavioral regression fail (`created` expected, `disabled` actual, exit 1).
The original source was restored byte-identically before final checks.

A further replay regression completes a package-created successor, materializes
its next occurrence, then reimports an older source with inherited series
metadata removed through both importer names. It must refuse the mismatched
existing target and retain exactly three items. Restoring the series-dependent
identity tuple makes this regression fail (exit 1); the predecessor-only tuple
prevents that duplicate even after provenance edits. The linked six-test suite
(including the model) passed, and the final six non-model feature regressions
passed again after this identity refinement. CI runs all seven feature tests
inside both unchanged npm/Bun full release gates.
