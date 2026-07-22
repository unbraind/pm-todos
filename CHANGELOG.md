# Changelog

## Unreleased

### Fixed

- Recommend pm merge reconcile (2026.7.22) over raw history-repair in Multi-agent merge safety docs ([pm-todos-11hd](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/issues/pm-todos-11hd.toon))

### Other

- Adopt pm field-aware merge driver for multi-agent branch-merge safety ([pm-todos-qa0y](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/chores/pm-todos-qa0y.toon))

## 2026.7.11 - 2026-07-11

### Added

- Full pm ecosystem production pass for pm-todos ([pm-todos-gev1](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/features/pm-todos-gev1.toon))

### Fixed

- Preserve rich JSONL fields across installed pm-todos import/export ([pm-todos-ejm7](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/issues/pm-todos-ejm7.toon))
- todos import/export unusable via CLI: importer/exporter registrations omit arguments+flags ([pm-todos-chgi](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/issues/pm-todos-chgi.toon))
- Adversarial review pass 2026-07-10 ([pm-todos-98ht](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/chores/pm-todos-98ht.toon))

### Other

- Production-readiness audit 2026-05-28 ([pm-todos-kgjf](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/tasks/pm-todos-kgjf.toon))
- Full-cycle hardening wave: pm-todos ([pm-todos-v3lk](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/tasks/pm-todos-v3lk.toon))
- Harden release bun-verify so registry-mirror lag cannot block the GitHub release ([pm-todos-sl3m](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/chores/pm-todos-sl3m.toon))

## 2026.7.10 - 2026-07-10

### Other

- Enhance pm-todos: jsonl, sync, filter, priority-map, checkbox formats ([pm-todos-272z](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/tasks/pm-todos-272z.toon))

## 2026.7.6 - 2026-07-06

### Fixed

- Fix release CI ordering (publish-before-tag) ([pm-todos-8gik](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/tasks/pm-todos-8gik.toon))

### Other

- Align Node engine with pm CLI runtime ([pm-todos-i0e1](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/tasks/pm-todos-i0e1.toon))
- Regenerate CHANGELOG after pm close item ([pm-todos-7dm6](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/tasks/pm-todos-7dm6.toon))

## 2026.6.9 - 2026-06-09

### Added

- Idempotent --upsert import (no duplicates on re-import) ([pm-todos-7l60](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/features/pm-todos-7l60.toon))
- Add native todo-state import/export support ([pm-todos-auvq](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/tasks/pm-todos-auvq.toon))

## 2026.6.7 - 2026-06-07

### Added

- Round-trip markdown TODO priority and due metadata ([pm-todos-68cf](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/features/pm-todos-68cf.toon))

### Other

- Harden release readiness checks ([pm-todos-200x](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/chores/pm-todos-200x.toon))
- Align package dependencies to pm CLI/SDK 2026.6.6 ([pm-todos-edol](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/chores/pm-todos-edol.toon))

## 2026.6.5-1 - 2026-06-05

### Fixed

- Round-trip import corrupts title + drops type (\[Type\] tag not parsed back) ([pm-todos-982k](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/issues/pm-todos-982k.toon))

## 2026.6.4-1 - 2026-06-04

### Added

- preflight: fail-fast todo.txt/markdown syntax gate before import ([pm-todos-86gr](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/features/pm-todos-86gr.toon))

## 2026.6.4 - 2026-06-04

### Other

- todo.txt date + key:value round-trip fidelity, --status import, export --sort ([pm-todos-qyv4](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/tasks/pm-todos-qyv4.toon))

## 2026.6.3 - 2026-06-02

### Added

- Deepen pm-todos: todo.txt + GH task-list + validate + grouping + full field round-trip ([pm-todos-vqr8](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/features/pm-todos-vqr8.toon))

### Other

- Full field round-trip in markdown (type/priority/tags/deadline/status/assignee) ([pm-todos-i8qd](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/tasks/pm-todos-i8qd.toon))
- --group-by status\|sprint\|type sectioning on export ([pm-todos-oqcd](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/tasks/pm-todos-oqcd.toon))
- todos validate <file\> command ([pm-todos-q1v5](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/tasks/pm-todos-q1v5.toon))
- GitHub-flavored task-list export (--format tasklist) ([pm-todos-hiry](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/tasks/pm-todos-hiry.toon))
- todo.txt format import + export (--format todotxt) ([pm-todos-1q04](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/tasks/pm-todos-1q04.toon))
- Decision: priority-letter<-\>number mapping ([pm-todos-c710](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/tasks/pm-todos-c710.toon))

## 2026.6.2 - 2026-06-02

### Added

- Enhance markdown TODO parser + native importer/exporter pipeline ([pm-todos-2e52](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/features/pm-todos-2e52.toon))

## 2026.6.1 - 2026-06-01

### Fixed

- Command handlers threw plain Error (no exitCode) → runtime double-invocation ([pm-todos-3nch](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/issues/pm-todos-3nch.toon))

## 2026.5.29 - 2026-05-29

### Added

- Hands-on functional test pass 2026-05-29 (real data) ([pm-todos-nhiu](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/features/pm-todos-nhiu.toon))

### Fixed

- todos import/export return error object instead of throwing (exit 0 on failure) ([pm-todos-2wy2](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/issues/pm-todos-2wy2.toon))
- todos import --dry-run silently ignored (still writes) ([pm-todos-mn0f](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/issues/pm-todos-mn0f.toon))

## 2026.5.28 - 2026-05-28

### Added

- Add publish retry + provenance fallback to release workflow ([pm-todos-kxlz](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/tasks/pm-todos-kxlz.toon))

## 2026.5.27 - 2026-05-27

### Added

- Add bun-install verification to release workflow ([pm-todos-y5jp](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/tasks/pm-todos-y5jp.toon))

## 2026.5.26 - 2026-05-26

### Fixed

- Fix .gitignore + release workflow conflict for dist/ ([pm-todos-rx7k](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/tasks/pm-todos-rx7k.toon))
- ci: fix release workflow step ordering ([pm-todos-rh95](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/tasks/pm-todos-rh95.toon))

### Other

- Release readiness hardening for pm-todos ([pm-todos-8a8c](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/tasks/pm-todos-8a8c.toon))
