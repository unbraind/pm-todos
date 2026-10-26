# pm-todos

Markdown TODO round-trip for [pm-cli](https://github.com/unbraind/pm-cli).

Import markdown checkboxes (`- [ ]` and `- [x]`) as pm items and export pm items back to markdown TODO lists.

The parser understands **nested/indented sub-tasks**, **section headers** (`## …` mapped to tags), **priority markers** (`(p1)` and `!`/`!!`/`!!!`), markdown `due:YYYY-MM-DD` metadata, and can import **multiple files at once** via a `--glob` pattern.

In addition to markdown, pm-todos imports and exports the de-facto [**todo.txt**](https://github.com/todotxt/todo.txt) format, exports **GitHub-flavored task lists**, **JSON Lines** (`jsonl`) and a flat **checkbox** markdown variant, imports/exports the `TodoDetails` JSON state used by the pi coding-agent `todo` tool, and **bidirectionally syncs** a file with the pm store. It can **group** exports into sections by status/sprint/type, **filter** by status/type, remap priorities (`number`/`letter`), and **validate** a TODO file without importing it.

---

## Installation

```bash
pm install npm:pm-todos --global
```

> The `npm:` prefix is required. A bare `pm install pm-todos` resolves only a local
> directory or a bundled alias, never the registry, and a
> `github.com/unbraind/pm-todos` source cannot work either — pm copies a GitHub
> source as-is without building it, and this repository does not commit `dist/`.

Or install locally:

```bash
pm install npm:pm-todos
```

Build manually:

```bash
git clone https://github.com/unbraind/pm-todos.git
cd pm-todos
npm install
npm run build
```

---

## Without git

Recurrence preview/apply use SDK storage and item locks and work in a plain
tracker without a `git` executable.

Requires pm CLI/SDK 2026.10.20 or later. TODO completion follows workspace status
roles, including custom terminal statuses. Imports, exports and sync use the
host-bound SDK client without launching a child pm process.

TODO validation, import, export, context, sync, editing sessions and source-change
proposals work in a plain pm tracker. No watcher command requires a Git repository
or invokes a git subprocess. Repository release and changelog tooling needs git;
GitHub workflows need their normal repository/tool credentials.

## Commands

| Command | Input and behavior |
|---|---|
| `pm todos import <file>` | Import a file, `--file` or `--glob`; `--dry-run` previews without mutations. |
| `pm todos-import import <file>` | Same inputs, flags, implementation and results as `todos import`. |
| `pm todos watch --file <file> --session <baseline> --spool <dir>` | Propose stable session edits without applying them; `--follow` streams receipts. |
| `pm todos validate <file>` | Validate input without importing. |
| `pm todos export` | Export tracker items. |
| `pm todos context` | Read the current context. |
| `pm todos sync <file>` | Import and write items back to the file. |

### `pm todos import <file>`

Parse a markdown file for `- [ ]` and `- [x]` checkboxes and create pm items.

> **Fail-fast syntax preflight.** Before any pm item is created, `import`
> validates the **syntax of every input file** (the same checks as
> `pm todos validate`). If any file contains a structural error — e.g. an
> invalid `due:` date or an out-of-range priority marker — the import **aborts
> immediately with a non-zero exit and creates no items**, naming the offending
> file, line and problem. This prevents partial imports where malformed input
> would otherwise be silently skipped (and, with `--glob`/multiple files, stops
> a bad file from landing only *after* earlier files were already written).
> Warnings (e.g. a line that resembles a checkbox but does not parse) are
> non-fatal and reported but do not block the import.

```bash
pm todos import TODO.md
pm todos import notes.md --dry-run
pm todos import backlog.md --type Task --priority 2
pm todos import --glob 'docs/**/*.md'
pm todos import TODO.md --section Backlog
pm todos import TODO.md --closed-as canceled
pm todos import TODO.md --status in_progress
pm todos import todo.txt --format todotxt
pm todos import todo-state.json --format todojson
pm todos import backlog.jsonl --format jsonl --upsert
pm todos import checklist.md --format checkbox
pm todos import TODO.md --upsert
```

**Flags**

| Flag | Type | Description |
|---|---|---|
| `--dry-run` | boolean | Preview without writing |
| `--upsert` | boolean | Update existing items instead of creating duplicates (idempotent re-import) |
| `--format <fmt>` | string | Source format: `markdown` (default), `todotxt`, `todojson`, `jsonl`, or `checkbox` |
| `--type <type>` | string | Item type (default: Task) |
| `--priority <n>` | number | Priority (0–4); overrides markers inferred from the text |
| `--tags <tags>` | string | Comma-separated tags applied to every item |
| `--glob <pattern>` | string | Import every markdown file matching the glob (e.g. `docs/**/*.md`) instead of a single positional file |
| `--section <name>` | string | Import only items found under this `##` section heading |
| `--closed-as <status>` | string | Status assigned to checked (`- [x]`) items (default: `closed`) |
| `--status <status>` | string | Status assigned to open (unchecked, `- [ ]`) items (default: `open`) |
| `--filter <expr>` | string | Filter parsed items by status/type before writing (e.g. `status=open,type=Task`) |
| `--no-section-tags` | boolean | Do not derive tags from section headings |

**Parsing rules**

- **Bullets**: `-`, `*` and `+` checkbox bullets are all recognised.
- **Nested sub-tasks**: indentation is preserved (sub-items are imported as their own items; indent is shown in `--dry-run`).
- **Section headers**: the nearest preceding `## Heading` is slugged (e.g. `## In Progress` → `in-progress`) and added as a tag, unless `--no-section-tags` is given.
- **Priority markers**: `(p0)`…`(p4)` set an explicit priority; trailing/leading `!`, `!!`, `!!!` map to priority `2`, `1`, `0`. Markers are stripped from the item title. An explicit `--priority` flag always wins.
- **Due dates**: `due:YYYY-MM-DD` is stripped from the markdown title and mapped to the item deadline. Invalid markdown `due:` dates are structural validation errors.
- **Embedded ids**: a trailing `<!-- pm-id -->` provenance comment (the one the
  exporter writes) is parsed off the line — it never becomes part of the title
  and is used to key `--upsert` re-imports back onto the original item.

#### Idempotent re-import (`--upsert`)

By **default** every checkbox is **created** as a new pm item, so re-importing the
same file *duplicates* its items (import a 5-item file twice → 10 items). This is
unchanged.

With **`--upsert`**, an import **updates matching items in place instead of
creating duplicates**, so the same file can be re-imported repeatedly without
growth. Each incoming line is matched to an existing pm item in this order:

1. **Embedded id** — the `<!-- pm-id -->` comment the exporter emits. This makes
   the full **export → edit → import `--upsert`** loop land edits back on the
   *same* items.
2. **Title signature** — a stable, case-/whitespace-insensitive match on the item
   title, for hand-written files that were never exported (no embedded id). The
   signature must match at most one existing item.

On a match the item is **updated** (title, type, priority, tags, deadline; status
only when it actually changed, to avoid a spurious re-close of an already-terminal
item). On no match it is **created** as usual. Embedded ids use exact matching and
never fall back to another item with the same title. Before writing, upsert
refuses repeated title signatures among incoming rows without ids, or a title
signature matching multiple existing items. Use distinct titles or embedded
`<!-- pm-id -->` comments to disambiguate. The check spans all input files and
also applies to dry-run. Plain imports without upsert still create every row.

```bash
pm todos import TODO.md            # creates (re-run duplicates)
pm todos import TODO.md --upsert   # updates in place (re-run is a no-op delta)
pm todos export --output TODO.md   # … then edit TODO.md …
pm todos import TODO.md --upsert   # edits land back on the same items
```

The result object reports `{ imported, updated, skipped }` under `--upsert`
(plain `{ imported, skipped }` otherwise). `--dry-run` previews the create/update
decision per item without writing.

#### todo.txt format (`--format todotxt`)

With `--format todotxt`, lines are parsed as [todo.txt](https://github.com/todotxt/todo.txt):

- `x` marks completion → status `closed`; `(A)`…`(Z)` maps to PM priority `0`…`4` (letters beyond `E` clamp). Explicit `--priority` wins.
- `due:YYYY-MM-DD` maps to the deadline.
- **Default `--todotxt-mapping tags` is lossy:** `+project` and `@context` both become PM tags (lowercased and deduplicated in the tracker), and all tags export as `+project`. Source dates and arbitrary `key:value` pairs are captured by the parser/SDK conversion but are not persisted by this default import policy. Priorities export as `A`…`E` and completed priorities are omitted. Do not use this mode to preserve source context knowledge.
- **Explicit `--todotxt-mapping fidelity` on import and export** retains the original project/context distinction, spelling, duplicates, and body token order, including `+x @x`. It persists source dates and arbitrary `key:value` tokens in namespaced extension fields, and retains original priorities `A`…`Z` (including completed priorities) while the mapped PM priority remains unchanged.

```bash
pm todos import todo.txt --format todotxt --todotxt-mapping fidelity
pm todos export --format todotxt --todotxt-mapping fidelity --output todo.txt
pm todos sync todo.txt --format todotxt --todotxt-mapping fidelity
```

The SDK uses the identical explicit policy:

```ts
const source = parseTodoTxtLine('x 2026-10-02 2026-10-01 Task +project @ctx');
if (source) {
  const item = todoTxtItemToPm(source, '', 'fidelity');
  const line = serializeTodoTxtLine(item, 'fidelity');
  // x 2026-10-02 2026-10-01 Task +project @ctx
}
```

`serializeTodoTxt(items, 'fidelity')` applies the same mapping to a document.
Generic PM tags without source provenance still export as projects; sparse Markdown output is unchanged. Existing imports cannot recover a context distinction that was already discarded: re-import the original todo.txt using fidelity mode.

Fidelity normalizes whitespace to single spaces and document line endings to LF; it preserves each row's body token order, not the tracker order of rows (use `--sort` to choose row order). Current PM edits take precedence: removed tags remove their source tokens, new tags append as projects, changed deadlines/key:value values retain their token positions, and a changed title moves ahead of retained metadata. PM tag identity is case-insensitive, so removing a shared tag removes both `+x` and `@x`; edit/re-import the source to remove only one occurrence. Upsert in fidelity mode clears absent source dates, key:value fields and deadline. An absent source priority maps to PM default priority `2` and exports without a priority marker while that default remains unchanged (PM does not support clearing priority via `--unset`). Re-importing in tags mode clears retained fidelity provenance. This is structured fidelity for the parser's supported grammar, not arbitrary byte-for-byte preservation.

#### pi coding-agent todo state (`--format todojson`)

With `--format todojson`, pm-todos reads and writes the `TodoDetails` payload from the pi coding-agent `todo` extension:

```json
{
  "action": "list",
  "todos": [
    { "id": 1, "text": "Import context", "done": false },
    { "id": 2, "text": "Export context", "done": true }
  ],
  "nextId": 3
}
```

Each todo becomes a pm item with `text` mapped to the title and `done` mapped to `closed` or `open`. Because the upstream todo model has no pm id field, `todojson` imports automatically use upsert matching by title so importing the same state repeatedly does not create duplicate pm items.

To keep downstream toggle semantics stable, todojson imports persist each incoming
numeric todo id in the generated item description as `todo-id:<n>`. On export,
pm-todos reuses those persisted ids (and only allocates new ids above the
current max when needed), so repeated import/export cycles keep existing ids
stable instead of re-numbering the full list.

#### JSON Lines (`--format jsonl`)

With `--format jsonl`, pm-todos reads and writes one compact JSON object per line, each
carrying the full pm item payload (id, title, status, type, priority, tags, deadline, …). A
`serialize → parse` cycle is lossless on every captured field, and the carried pm `id` is the
`--upsert` match key, so importing the same file repeatedly never duplicates items.

Rich fields (`description`, `assignee`, `sprint`, todo dates, source timestamps, and `kv`)
also survive an installed-package import/store/export cycle. pm-todos uses namespaced SDK
fields for source timestamps, todo dates, and `kv` so it never overwrites pm's reserved audit
metadata. Object-valued `kv` entries are normalized to compact JSON strings; scalar values are
normalized to strings. This keeps the interchange deterministic without producing
`[object Object]` or discarding nested context.

```jsonl
{"id":"pm-1","title":"Write docs","status":"open","priority":1,"tags":["docs"],"deadline":"2026-09-01"}
{"id":"pm-2","title":"Done thing","status":"closed"}
```

#### Flat checkbox markdown (`--format checkbox`)

`--format checkbox` is a markdown variant: a flat list of `- [ ]` / `- [x]` lines (one per item),
each carrying a `<!-- pm-id -->` provenance comment, **without** the `# TODO` header or the
`## Open` / `## Done` (or `--group-by`) sectioning of the default markdown export. The import
grammar is identical to the default `markdown` parser, so the import/export direction is a clean
round-trip. It is convenient for embedding in existing markdown docs that already provide their
own structure.

### `pm todos export`

Export pm items as a markdown TODO list, a todo.txt file, a GitHub-flavored task list, JSON Lines, or a flat checkbox list.

```bash
pm todos export
pm todos export --output TODO.md
pm todos export --status open --output backlog.md
pm todos export --type Task
pm todos export --format todotxt --output todo.txt
pm todos export --format todojson --output todo-state.json
pm todos export --format jsonl --output backlog.jsonl
pm todos export --format checkbox --output checklist.md
pm todos export --format tasklist --group-by sprint
pm todos export --group-by type
pm todos export --sort priority
pm todos export --sort deadline --status open
pm todos export --metadata --output TODO.md
pm todos export --metadata --priority-map letter --output TODO.md
pm todos export --filter status=open,type=Task --output TODO.md
pm todos export --sort priority --reverse --output backlog.md
```

**Flags**

| Flag | Type | Description |
|---|---|---|
| `--output <file>` | string | Write to file instead of stdout |
| `--format <fmt>` | string | Output format: `markdown` (default), `todotxt`, `tasklist` (GitHub task list), `todojson`, `jsonl`, or `checkbox` |
| `--group-by <field>` | string | Section markdown/tasklist output by `status` (default), `sprint`, or `type` |
| `--sort <key>` | string | Sort items by `priority` (0 highest first), `deadline` (ascending), or `title` (alphabetical). Unset preserves pm's native order |
| `--status <status>` | string | Filter by status |
| `--type <type>` | string | Filter by item type |
| `--filter <expr>` | string | Filter items by status/type (e.g. `status=open` or `status=open,type=Task`); complements `--status`/`--type` |
| `--metadata` | boolean | Include parseable priority and `due:YYYY-MM-DD` tokens in markdown/tasklist output |
| `--priority-map <scheme>` | string | Priority token scheme for markdown/tasklist `--metadata`: `number` (default, `(p0)`..`(p4)`) or `letter` (`(A)`..`(E)`) |
| `--reverse` | boolean | Reverse the final export order; without `--sort` this flips pm's native order, while `--sort priority --reverse` yields lowest priority first |

Upsert indexing and export both read the whole tracker through the canonical
`pm list --all --json` contract with bodies, strict reads, full projection, no
truncation, and both universal output bounds disabled. The public pm SDK
certifies source, filter, pagination, projection, count, and row-identity
evidence; pm-todos additionally refuses missing or contradictory unreadable,
omission, read-output, dimension, and budget-disclosure receipts. An
unverifiable tracker read fails before it can create duplicate imports or write
a partial TODO export.

The default `markdown` export (no `--group-by`, or `--group-by status`) is unchanged: a
`# TODO` document with `## Open` / `## Done` sections. `--group-by sprint`/`type` emits a
`## <value>` section per group. The `todotxt` exporter maps priority→letter, tags→`+project` by default (use `--todotxt-mapping fidelity` for retained source tokens),
and deadline→`due:`. The `todojson` exporter emits a pi coding-agent `TodoDetails` object
with sequential numeric todo ids, `text`, `done`, and `nextId`. The `tasklist` exporter emits `- [ ]` / `- [x]` items grouped under
`## <heading>` sections, each carrying a `<!-- pm-id -->` comment for round-trips. The `jsonl`
exporter writes one compact JSON object per line carrying the full pm item payload (lossless
round-trip). The `checkbox` exporter writes a flat `- [ ]` / `- [x]` list with no header or
sections.

`--metadata` is opt-in so the historical markdown output stays byte-stable. When
enabled, markdown/tasklist exports include priority and `due:YYYY-MM-DD` tokens that
the importer already parses, allowing priority and deadline to survive a
markdown export → edit → `pm todos import --upsert` cycle. `--priority-map letter` switches
the priority token to the todo.txt-style `(A)`..`(E)` letter scheme (default is `(p0)`..`(p4)`).

`--filter` is a comma-separated `key=value` (or `key:value`) predicate limited to the
`status` and `type` keys. An explicit `--status` / `--type` flag takes precedence over a
conflicting `--filter` key. The same predicate is also honoured by `pm todos import` and
`pm todos sync`, where it filters which parsed items are written.

### `pm todos sync <file>`

Bidirectionally reconcile a TODO file with the pm store. `todos sync` imports file changes
into pm (always upserting, so re-syncing never duplicates) and then writes a fresh export of
the reconciled pm state back to the **same** file, so pm-side changes (ids, statuses,
priorities, deadlines) flow back to the file. The file and the pm store converge to the same
state.

```bash
pm todos sync TODO.md
pm todos sync todo.txt --format todotxt
pm todos sync todo-state.json --format todojson
pm todos sync backlog.jsonl --format jsonl --filter status=open
pm todos sync TODO.md --format checkbox --metadata --priority-map letter
pm todos sync TODO.md --dry-run
```

`todos sync` supports every round-trippable format (`markdown`, `todotxt`, `todojson`,
`jsonl`, `checkbox`); `tasklist` is export-only and rejected. It accepts the same
`--format`, `--type`, `--closed-as`, `--status`, `--priority`, `--tags`, `--section`,
`--no-section-tags`, `--group-by`, `--metadata`, `--priority-map`, `--filter`, and `--dry-run`
flags as import/export; `--file <path>` is an alternative to the positional file.
Sync refuses ambiguous title signatures before changing the tracker or file,
reporting the colliding file:line locations (and existing item ids when applicable).
For example, `Task +one` and `Task @two` both have title `Task` in todo.txt;
use distinct titles in either `tags` or `fidelity` mapping. Equal markdown titles
need distinct titles or exact embedded `<!-- pm-id -->` comments. Under
`--dry-run` the same ambiguity checks run and nothing is written to the pm store
or the file. Sync refuses to replace a
non-empty file with an empty result (for example, when a restrictive filter matches
nothing); pass `--allow-empty` only when clearing the file is intentional.

### `pm todos context`

Return a compact workspace snapshot designed for agent handoffs: status/type counts,
urgency counters, and a bounded focus list (instead of a full markdown export).

```bash
pm todos context
pm todos context --status open --sort priority
pm todos context --type Task --limit 10
pm todos context --include-tags
```

**Flags**

| Flag | Type | Description |
|---|---|---|
| `--status <status>` | string | Filter by status before summarizing |
| `--type <type>` | string | Filter by item type before summarizing |
| `--sort <key>` | string | Focus order: `priority`, `deadline`, or `title` (default uses triage ordering) |
| `--limit <n>` | number | Max focus rows to include (1–200, default: 20) |
| `--include-tags` | boolean | Include tags on focus rows (off by default for token efficiency) |

By default, `context` orders focus items by active-work priority (`in_progress`,
`blocked`, `open`, `draft`, then terminal states), then by priority and deadline.
This gives agents high-signal context in fewer tokens while keeping import/export
behavior unchanged.

### `pm todos validate <file>`

Parse a TODO file and report problems **without importing**. Exits non-zero when structural
errors (malformed `due:` dates, out-of-range priorities) are found, so it is safe to gate CI on.

```bash
pm todos validate TODO.md
pm todos validate todo.txt --format todotxt
pm todos validate todo-state.json --format todojson
pm todos validate backlog.jsonl --format jsonl
pm todos validate checklist.md --format checkbox
pm todos validate TODO.md --json
```

**Flags**

| Flag | Type | Description |
|---|---|---|
| `--format <fmt>` | string | File format: `markdown` (default), `todotxt`, `todojson`, `jsonl`, or `checkbox` |
| `--json` | boolean | Return a JSON report (with the full `issues` array) on stdout |

Errors (e.g. an invalid `due:` date, a `(p9)` marker out of the `0–4` range) cause a non-zero
exit; warnings (empty task text, a checkbox-looking line that doesn't parse) do not. A
human-readable summary is always written to stderr; under `--json` the structured report is
returned on stdout for valid files.

---

## Native import/export pipeline

pm-todos registers a first-class `todos` importer and exporter, so markdown is a
native pm import/export format. These power the `pm todos import` / `pm todos
export` routes above and can also be driven programmatically:

```jsonc
{
  "importers": [
    {
      "name": "todos",
      "config": {
        "glob": "docs/**/*.md",   // or "file": "./TODO.md"
        "section": "Backlog",      // optional
        "closed-as": "canceled",   // optional
        "type": "Task"             // optional
      }
    }
  ]
}
```

The `todos` exporter accepts `output`, `status`, `type`, `format`, `group-by`, `metadata`, `sort`, and
`todotxt-mapping` options and emits the same output produced by `pm todos export` (default
markdown, or `todotxt` / `tasklist` / `todojson`). The `todos` importer additionally accepts
`format` (`markdown` | `todotxt` | `todojson`) and `status` (status for open items, complementing
`closed-as`).

### Legacy importer: `todos-import`

The original `todos-import` name is retained for configured callers. Its CLI
spelling `pm todos-import import <file>` now shares the native `todos import`
handler and every flag, including `--file`, `--glob`, `--format`, `--upsert` and
`--dry-run`. Missing input exits nonzero; previews leave durable tracker state
and source files unchanged. Programmatic `options.file` remains supported:

```jsonc
{
  "importers": [
    {
      "name": "todos-import",
      "config": { "file": "./TODO.md" }
    }
  ]
}
```

---

## License

MIT

## Release Automation

The release gate runs type checking, build, docstring and configured coverage
checks, production dependency audit, package packing, deterministic
pm-changelog validation, a canonical-reader integration acceptance, and a fresh
packed-extension matrix. The integration acceptance proves that upsert and
export each issue one exact complete-corpus read. The packed matrix uses
npm/npx and Bun/bunx against both the current development pm host and the
declared minimum host, creates real tracker data, exercises upsert
import and complete JSONL export, and rejects deprecated-command diagnostics.
Independent honest all-source coverage and reachable-history privacy items
remain authoritative readiness gates; passing the packed matrix alone is not
publication approval. The daily release workflow runs only when commits
exist after the latest release tag and generates both `CHANGELOG.md` and GitHub
release notes with pm-changelog.

## Multi-agent merge safety

This repo tracks its project management in `.agents/pm/` and ships a committed `.gitattributes`
that maps those tracker artifacts to pm-cli's field-aware Git merge drivers, so concurrent-branch
tracker edits merge cleanly instead of hard-conflicting. The driver **definitions** live in
per-clone Git config; `npm install` / `npm ci` wires them automatically via the `prepare` script, `scripts/prepare-merge-driver.ts`: the pinned pm-ops launcher is preserved unchanged after a local artifact guard backported from pm-ops PR #152. Tests compare the installer suffix byte for byte and verify that `npm pack` / `npm publish` skip merge-driver configuration even with a held Git config lock. This avoids concurrent packing fixtures writing the same clone config when npm 10 runs `prepare` despite `--ignore-scripts`. It runs pm-ops's installer, which calls `pm merge install` when the `pm` CLI is on `PATH` and skips with a notice when it is not. A production install of a clone (`npm ci --omit=dev`) has no `pm-ops`, so the launcher skips with one notice, while a stale or broken `pm-ops` fails the install. Registry installs of this package never run `prepare`. Being Node-based, it behaves identically on POSIX shells and Windows `cmd.exe`. To (re)run manually: `npm run merge:install`.

After merging a branch that touched `.agents/pm/`, reconcile any residual history-hash drift with
**`pm merge reconcile`** (pm-cli ≥ 2026.7.22): preview with `pm merge reconcile --dry-run`, apply with
`pm merge reconcile --message "post-merge reconcile"`, then confirm with `pm validate`, which scans the
whole tracker and flags remaining history drift across **every** affected item (`pm merge reconcile`
itself lists each affected stream in its output; `pm history --verify <id>` spot-checks one item). The field-aware driver already unions every author's
content, so `reconcile` only re-greens the hash chain (no data loss) — see the authoritative
[pm-cli merge-safety guide](https://github.com/unbraind/pm-cli/blob/main/docs/MERGE_SAFETY.md). The
older blunt `pm history-repair --all` remains available as a lower-level primitive.

## Explicit weekly recurrence

`pm todos recur preview <id> --dialect todotxt-weekly-v1` interprets a completed
**fidelity** todo.txt item and returns one proposed successor, its stable series
and occurrence ids, the intended schedule and source revision. An absent successor
has `targetExists: false`; its proposed schedule lives only under `intended`. Existing
successors include SDK-read `stored` facts and `targetRevision`.
Apply is explicit and requires that revision:

```bash
pm todos recur preview project-weekly --dialect todotxt-weekly-v1 --json
pm todos recur apply project-weekly --dialect todotxt-weekly-v1 --expected-revision <revision>
```

- `rec:+1w` through `rec:+52w` advance from the source due date.
- `rec:1w` through `rec:52w` advance from `todos_completion_date`, retained by
  fidelity import. Missing completion dates are refused, never inferred from now.
- Dates are real Gregorian `YYYY-MM-DD` values in years 0001–9999. The only
  timezone policy is `floating`: calendar addition has no timezone conversion or
  DST ambiguity. Timestamps, offsets, IANA zones, rollover dates and overflow
  receive typed refusals with remedies. The current SDK deadline must agree with
  the retained source due token. Duplicate `rec`/`due` tokens are refused.
- Omitting `--dialect` disables recurrence and performs no tracker reads or writes.
  Original source text, due date, relationships and history remain unchanged even
  when enabled. Core status registry **done** roles enable recurrence; canceled,
  blocked and active roles do not.

A successor is a new Task in the configured open status. It copies title,
priority, tags and source recurrence, with the next deadline; it does not inherit
assignment, relationships, completion evidence, body or reminders. No scheduler
or daemon is installed. Due-anchored overdue work advances exactly one interval,
without catching up to the wall clock. Complete each successor explicitly before
previewing the following occurrence.

Existing `todos_kv` metadata carries reserved `pmseries`, `pmoccurrence`,
`pmoriginaldue`, `pmprevious`, `pmrevision` and `pmanchor` keys. JSONL and todo.txt **fidelity**
exports preserve them. Use JSONL for a lossless identity-bearing interchange;
Markdown, tasklist and todojson are intentionally narrower projections. Same-title
recurrences can make idless todo.txt upserts ambiguous; use JSONL stable ids.
An imported occurrence lacks the materializer's original creation receipt and is
reported as foreign rather than adopted. Reserved keys on an external original
must be reviewed explicitly before starting a new series.

The successor id depends on its predecessor identity, so later comments, old-input
replays or changed dates never create a second successor for that predecessor.
Every apply revalidates the immutable source revision inside the SDK item lock,
reads the live target, and uses native atomic SDK creation. Retry after an
interruption previews current state again. An owned successor is `unchanged` only when its stored deadline, rule, anchor,
original due and configured open status equal the intended schedule. Unrelated
peer title/comments edits remain intact. A source rule/due/completion change
produces a `reschedule` preview with separate `stored` and `intended` values.
Apply additionally requires `--expected-target-revision <targetRevision>`
(SDK `expectedTargetRevision`), rechecks that exact revision inside the successor
lock, and returns `rescheduled` after SDK read-back. `updated` is 0 or 1.

Every materialized receipt's top-level `nextDue`, identity, provenance and
`status` come from the live SDK target, including after competing transitions;
they never echo the intended calculation. A peer's manual deadline, recurrence,
source scheduling-token or lifecycle change is `foreign_schedule`, preserved
without overwrite. A stale target plan is `target_conflict`. Deleted successors
are `target_deleted` and never recreated from an old plan. Corrupt or foreign
identities are refused. The latest package-written schedule is reconstructed by
SDK history replay, without history edits or a frozen journal.

The SDK exports `previewTodoOccurrence`, `applyTodoOccurrence` and typed requests,
results, refusal codes and transition observations. Results contain one receipt
with a `created` count of 0 or 1; default CLI output is compact TOON (`--json` is
also available). Input ids are bounded to 160 characters, authors to 80, source
lines to 16384, titles to 4096, and metadata/tags to 100 entries; oversized or
unsupported values are refused. [SDK example](docs/recurrence-example.md).

## Conflict-aware todo.txt editing sessions

Use `pm todos session export --file todo.txt --session baseline.json`, edit the
text while retaining each `pm-session:<id>` token, then run `preview` and `apply`
with the same flags. A baseline sidecar holds stable item and field digests.
Independent tracker edits survive; competing edits return typed conflicts with
remedies. Deleted lines retain their items. Unchanged imports are idempotent.
The SDK exports the same session and reconciliation operations. Receipts are
compact TOON by default or JSON with `--json`, with at most 20 refusal details.
See the [worked example and limits](docs/editing-sessions.md).

## Source change proposals

`pm todos watch` reads exactly one authorized **session todo.txt** file (created
with `todos session export`). It reuses the session three-way planner, so omitted
rows are retained and lifecycle changes require `pm close` / `pm reopen` with a
reason. This watcher proposes edits to known identities; create new items with
`pm create`. Other import formats remain available through `pm todos import`.

```sh
pm todos session export --file review.txt --session baseline.json
# Edit review.txt, keeping the trailing pm-session identities.
pm todos watch --file review.txt --session baseline.json --spool proposals --json
# Continuously watch the same file; Ctrl-C / SIGTERM stops cleanly.
pm todos watch --file review.txt --session baseline.json --spool proposals --follow
```

The default command samples twice, with a 500 ms stability window, and returns
one compact TOON receipt (`--json` selects JSON). A concurrent save may return
`state: waiting`; retry after it finishes. Follow mode polls every 100 ms and
streams compact NDJSON receipts only when their state changes. It finishes any
in-flight persistence before stopping. The SDK offers `TodoSourceWatcher.poll()`
and `run(signal, emit)` with the same typed `TodoWatcherReceipt` contract; see
[the SDK example](docs/source-watcher-example.md).

A stable write must have identical content across the stability window, be a
regular UTF-8 file within the byte limit, and end with a newline (empty truncation
is safe). The source and baseline are checked again after planning. Partial lines
are refused, malformed identities/conflicts return the existing bounded session
refusals, and **missing lines never become deletions**. A syntactically complete
intermediate save can produce a proposal; stability is a sampling heuristic, not
proof that an external editor has finished. Nothing is applied automatically.

`proposals/proposals.json` keeps source snapshots, field patches and source,
baseline and complete-tracker revision hashes. In each persisted patch, `values`
contains only fields to set; `removedFields` explicitly lists fields to delete.
For example, removing `due:2026-12-01` produces `"removedFields":["deadline"]`
instead of losing that change during JSON serialization. Queue/proposal schema
version 2 requires this explicit encoding. Legacy version 1 queues are preserved
and refused with `spool_mismatch`; archive them and use a fresh spool to regenerate
complete proposals from the saved source and original baseline.

Identical content after atomic
replacement, repeated polls and restarts deduplicates. Tracker revision changes
produce fresh review evidence. Treat the proposal as stale after any source,
baseline or tracker change: review its saved `text` in a separate file against the
original sidecar with `todos session preview`, then explicitly use `session apply`
if approved. Apply rechecks conflicts under core item locks; watcher receipts do
not grant approval or bypass lifecycle rules. Hashes detect revisions and accidental
corruption; they do not authenticate an untrusted spool.

Keep the spool outside the tracker and preserve it across restarts. The watcher
never removes pending proposals. After review, archive the entire spool and start
a fresh one; restarting with the existing spool preserves deduplication. Use a
fresh spool after exporting a different baseline. No filesystem discovery or git
subprocess is used. Final-component source/sidecar symlinks and special files are
refused; the supplied parent directories and spool must be trusted.

Limits are positive integers: `--max-bytes` defaults to 1 MiB (hard ceiling 4 MiB),
`--max-changes` to 100 (ceiling 1,000), and `--max-pending` to 20 (ceiling 100).
One-shot mode rechecks the monotonic stability interval after every timer wake.
It waits for at most `max(1,000 ms, 3 × stableMs)` while sampling; in-flight file,
tracker and queue I/O finishes normally. An unchanged file queues a durable
proposal (including zero-change proposals), or returns `duplicate` for existing
evidence. If the source keeps changing until that budget expires, the command
exits nonzero with a typed `still_waiting` refusal and remedy: stop the writer and
retry, or use `--follow`. Other I/O and planning refusals also exit nonzero.
SIGINT/SIGTERM during one-shot waiting use normal process cancellation; follow
mode finishes in-flight persistence before stopping.

The sidecar ceiling is eight times the source byte limit; the total queue ceiling
is 16 MiB. `--stable-ms` and `--poll-ms` have a 60,000 ms ceiling. Limit violations
refuse the whole proposal with a typed code and remedy; they never silently truncate
changes or evict pending work. Queue writes use the public SDK atomic writer and
queue lock. This guarantees completed proposals survive normal shutdown and
process restart; it does not assert power-loss durability.
