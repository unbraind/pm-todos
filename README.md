# pm-todos

Markdown TODO round-trip for [pm-cli](https://github.com/unbraind/pm-cli).

Import markdown checkboxes (`- [ ]` and `- [x]`) as pm items and export pm items back to markdown TODO lists.

The parser understands **nested/indented sub-tasks**, **section headers** (`## …` mapped to tags), **priority markers** (`(p1)` and `!`/`!!`/`!!!`), and can import **multiple files at once** via a `--glob` pattern.

In addition to markdown, pm-todos round-trips the de-facto [**todo.txt**](https://github.com/todotxt/todo.txt) format and exports **GitHub-flavored task lists**, can **group** exports into sections by status/sprint/type, and can **validate** a TODO file without importing it.

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

```bash
pm todos import TODO.md
pm todos import notes.md --dry-run
pm todos import backlog.md --type Task --priority 2
pm todos import --glob 'docs/**/*.md'
pm todos import TODO.md --section Backlog
pm todos import TODO.md --closed-as canceled
pm todos import TODO.md --status in_progress
pm todos import todo.txt --format todotxt
```

**Flags**

| Flag | Type | Description |
|---|---|---|
| `--dry-run` | boolean | Preview without writing |
| `--format <fmt>` | string | Source format: `markdown` (default) or `todotxt` |
| `--type <type>` | string | Item type (default: Task) |
| `--priority <n>` | number | Priority (0–4); overrides markers inferred from the text |
| `--tags <tags>` | string | Comma-separated tags applied to every item |
| `--glob <pattern>` | string | Import every markdown file matching the glob (e.g. `docs/**/*.md`) instead of a single positional file |
| `--section <name>` | string | Import only items found under this `##` section heading |
| `--closed-as <status>` | string | Status assigned to checked (`- [x]`) items (default: `closed`) |
| `--status <status>` | string | Status assigned to open (unchecked, `- [ ]`) items (default: `open`) |
| `--no-section-tags` | boolean | Do not derive tags from section headings |

**Parsing rules**

- **Bullets**: `-`, `*` and `+` checkbox bullets are all recognised.
- **Nested sub-tasks**: indentation is preserved (sub-items are imported as their own items; indent is shown in `--dry-run`).
- **Section headers**: the nearest preceding `## Heading` is slugged (e.g. `## In Progress` → `in-progress`) and added as a tag, unless `--no-section-tags` is given.
- **Priority markers**: `(p0)`…`(p4)` set an explicit priority; trailing/leading `!`, `!!`, `!!!` map to priority `2`, `1`, `0`. Markers are stripped from the item title. An explicit `--priority` flag always wins.

#### todo.txt format (`--format todotxt`)

With `--format todotxt`, lines are parsed as [todo.txt](https://github.com/todotxt/todo.txt):

- `x` at the start marks completion → status `closed` (an optional completion date is recognised and skipped).
- `(A)`…`(Z)` priority letter → pm numeric priority (`(A)`→`0`, …, `(E)`→`4`; letters past `E` clamp to `4`). An explicit `--priority` flag still wins.
- `+project` and `@context` tokens → tags (pm folds tags to lowercase).
- `due:YYYY-MM-DD` → the item deadline. Other `key:value` pairs are ignored on pm import (pm has no field for them), but are **preserved through a todo.txt round-trip** at the format layer.
- **Creation and completion dates** (`x <completion> <creation> …` for done items, `(A) <creation> …` for open items) are parsed and **re-emitted on todo.txt export**, so a todo.txt → todo.txt round-trip is lossless on dates and `key:value` metadata.

### `pm todos export`

Export pm items as a markdown TODO list, a todo.txt file, or a GitHub-flavored task list.

```bash
pm todos export
pm todos export --output TODO.md
pm todos export --status open --output backlog.md
pm todos export --type Task
pm todos export --format todotxt --output todo.txt
pm todos export --format tasklist --group-by sprint
pm todos export --group-by type
pm todos export --sort priority
pm todos export --sort deadline --status open
```

**Flags**

| Flag | Type | Description |
|---|---|---|
| `--output <file>` | string | Write to file instead of stdout |
| `--format <fmt>` | string | Output format: `markdown` (default), `todotxt`, or `tasklist` (GitHub task list) |
| `--group-by <field>` | string | Section markdown/tasklist output by `status` (default), `sprint`, or `type` |
| `--sort <key>` | string | Sort items by `priority` (0 highest first), `deadline` (ascending), or `title` (alphabetical). Unset preserves pm's native order |
| `--status <status>` | string | Filter by status |
| `--type <type>` | string | Filter by item type |

The default `markdown` export (no `--group-by`, or `--group-by status`) is unchanged: a
`# TODO` document with `## Open` / `## Done` sections. `--group-by sprint`/`type` emits a
`## <value>` section per group. The `todotxt` exporter maps priority→letter, tags→`+project`,
and deadline→`due:`. The `tasklist` exporter emits `- [ ]` / `- [x]` items grouped under
`## <heading>` sections, each carrying a `<!-- pm-id -->` comment for round-trips.

### `pm todos validate <file>`

Parse a TODO file and report problems **without importing**. Exits non-zero when structural
errors (malformed `due:` dates, out-of-range priorities) are found, so it is safe to gate CI on.

```bash
pm todos validate TODO.md
pm todos validate todo.txt --format todotxt
pm todos validate TODO.md --json
```

**Flags**

| Flag | Type | Description |
|---|---|---|
| `--format <fmt>` | string | File format: `markdown` (default) or `todotxt` |
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

The `todos` exporter accepts `output`, `status`, `type`, `format`, `group-by` and
`sort` options and emits the same output produced by `pm todos export` (default
markdown, or `todotxt` / `tasklist`). The `todos` importer additionally accepts
`format` (`markdown` | `todotxt`) and `status` (status for open items, complementing
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
