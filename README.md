# pm-todos

Markdown TODO round-trip for [pm-cli](https://github.com/unbraind/pm-cli).

Import markdown checkboxes (`- [ ]` and `- [x]`) as pm items and export pm items back to markdown TODO lists.

The parser understands **nested/indented sub-tasks**, **section headers** (`## …` mapped to tags), **priority markers** (`(p1)` and `!`/`!!`/`!!!`), and can import **multiple files at once** via a `--glob` pattern.

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
```

**Flags**

| Flag | Type | Description |
|---|---|---|
| `--dry-run` | boolean | Preview without writing |
| `--type <type>` | string | Item type (default: Task) |
| `--priority <n>` | number | Priority (0–4); overrides markers inferred from the text |
| `--tags <tags>` | string | Comma-separated tags applied to every item |
| `--glob <pattern>` | string | Import every markdown file matching the glob (e.g. `docs/**/*.md`) instead of a single positional file |
| `--section <name>` | string | Import only items found under this `##` section heading |
| `--closed-as <status>` | string | Status assigned to checked (`- [x]`) items (default: `closed`) |
| `--no-section-tags` | boolean | Do not derive tags from section headings |

**Parsing rules**

- **Bullets**: `-`, `*` and `+` checkbox bullets are all recognised.
- **Nested sub-tasks**: indentation is preserved (sub-items are imported as their own items; indent is shown in `--dry-run`).
- **Section headers**: the nearest preceding `## Heading` is slugged (e.g. `## In Progress` → `in-progress`) and added as a tag, unless `--no-section-tags` is given.
- **Priority markers**: `(p0)`…`(p4)` set an explicit priority; trailing/leading `!`, `!!`, `!!!` map to priority `2`, `1`, `0`. Markers are stripped from the item title. An explicit `--priority` flag always wins.

### `pm todos export`

Export pm items as a markdown TODO list.

```bash
pm todos export
pm todos export --output TODO.md
pm todos export --status open --output backlog.md
pm todos export --type Task
```

**Flags**

| Flag | Type | Description |
|---|---|---|
| `--output <file>` | string | Write to file instead of stdout |
| `--status <status>` | string | Filter by status |
| `--type <type>` | string | Filter by item type |

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

The `todos` exporter accepts `output`, `status` and `type` options and emits the
same grouped (`## Open` / `## Done`) markdown produced by `pm todos export`.

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
