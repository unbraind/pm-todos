# pm-todos

Markdown TODO round-trip for [pm-cli](https://github.com/unbraind/pm-cli).

Import markdown checkboxes (`- [ ]` and `- [x]`) as pm items and export pm items back to markdown TODO lists.

The parser understands **nested/indented sub-tasks**, **section headers** (`## …` mapped to tags), **priority markers** (`(p1)` and `!`/`!!`/`!!!`), markdown `due:YYYY-MM-DD` metadata, and can import **multiple files at once** via a `--glob` pattern.

In addition to markdown, pm-todos round-trips the de-facto [**todo.txt**](https://github.com/todotxt/todo.txt) format, exports **GitHub-flavored task lists**, **JSON Lines** (`jsonl`) and a flat **checkbox** markdown variant, imports/exports the `TodoDetails` JSON state used by the pi coding-agent `todo` tool, and **bidirectionally syncs** a file with the pm store. It can **group** exports into sections by status/sprint/type, **filter** by status/type, remap priorities (`number`/`letter`), and **validate** a TODO file without importing it.

---

## Installation

```bash
pm install github.com/unbraind/pm-todos --global
```

Or install locally:

```bash
pm install github.com/unbraind/pm-todos
```

Build manually:

```bash
git clone https://github.com/unbraind/pm-todos.git
cd pm-todos
npm install
npm run build
```

---

## Commands

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
   oldest matching item wins.

On a match the item is **updated** (title, type, priority, tags, deadline; status
only when it actually changed, to avoid a spurious re-close of an already-terminal
item). On no match it is **created** as usual. Items created earlier in the same
run are themselves matchable, so a file containing the same task twice converges
on one item.

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

- `x` at the start marks completion → status `closed` (an optional completion date is recognised and skipped).
- `(A)`…`(Z)` priority letter → pm numeric priority (`(A)`→`0`, …, `(E)`→`4`; letters past `E` clamp to `4`). An explicit `--priority` flag still wins.
- `+project` and `@context` tokens → tags (pm folds tags to lowercase).
- `due:YYYY-MM-DD` → the item deadline. Other `key:value` pairs are ignored on pm import (pm has no field for them), but are **preserved through a todo.txt round-trip** at the format layer.
- **Creation and completion dates** (`x <completion> <creation> …` for done items, `(A) <creation> …` for open items) are parsed and **re-emitted on todo.txt export**, so a todo.txt → todo.txt round-trip is lossless on dates and `key:value` metadata.

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

The default `markdown` export (no `--group-by`, or `--group-by status`) is unchanged: a
`# TODO` document with `## Open` / `## Done` sections. `--group-by sprint`/`type` emits a
`## <value>` section per group. The `todotxt` exporter maps priority→letter, tags→`+project`,
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
flags as import/export; `--file <path>` is an alternative to the positional file. Under
`--dry-run` nothing is written to the pm store or the file. Sync refuses to replace a
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

The `todos` exporter accepts `output`, `status`, `type`, `format`, `group-by`, `metadata`, and
`sort` options and emits the same output produced by `pm todos export` (default
markdown, or `todotxt` / `tasklist` / `todojson`). The `todos` importer additionally accepts
`format` (`markdown` | `todotxt` | `todojson`) and `status` (status for open items, complementing
`closed-as`).

### Legacy importer: `todos-import`

The original `todos-import` importer is retained for backward compatibility:

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

This package is release-ready for GitHub, npm, and Bun-compatible installs. CI runs type checking, build, production dependency audit, package packing, Bun install verification, and pm-changelog validation. The daily release workflow publishes only when commits exist after the latest release tag and uses pm-changelog to generate CHANGELOG.md and GitHub release notes.

## Multi-agent merge safety

This repo tracks its project management in `.agents/pm/` and ships a committed `.gitattributes`
that maps those tracker artifacts to pm-cli's field-aware Git merge drivers, so concurrent-branch
tracker edits merge cleanly instead of hard-conflicting. The driver **definitions** live in
per-clone Git config; `npm install` / `npm ci` wires them automatically via the `prepare` script (a portable Node guard, `scripts/prepare-merge-driver.mjs`: it runs
`pm merge install` only when the `pm` CLI is on `PATH`, and no-ops cleanly otherwise so
production / `--omit=dev` installs are not broken; being Node-based it behaves identically
on POSIX shells and Windows `cmd.exe`). To (re)run manually: `npm run merge:install`. After merging a branch that
touched `.agents/pm/`, run `pm history-repair --all` to reconcile history verification.
