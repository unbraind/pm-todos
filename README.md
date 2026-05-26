# pm-todos

Markdown TODO round-trip for [pm-cli](https://github.com/unbraind/pm-cli).

Import markdown checkboxes (`- [ ]` and `- [x]`) as pm items and export pm items back to markdown TODO lists.

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
```

**Flags**

| Flag | Type | Description |
|---|---|---|
| `--dry-run` | boolean | Preview without writing |
| `--type <type>` | string | Item type (default: Task) |
| `--priority <n>` | number | Priority (0–4) |
| `--tags <tags>` | string | Comma-separated tags |

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

## Programmatic importer: `todos-import`

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
