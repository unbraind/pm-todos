# Changelog

## Unreleased

### Fixed

- Command handlers threw plain Error \(no exitCode\) → runtime double-invocation ([pm-todos-3nch](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/issues/pm-todos-3nch.toon))

## 2026.05.29 - 2026-05-29

### Added

- Hands-on functional test pass 2026-05-29 \(real data\) ([pm-todos-nhiu](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/features/pm-todos-nhiu.toon))

### Fixed

- todos import/export return error object instead of throwing \(exit 0 on failure\) ([pm-todos-2wy2](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/issues/pm-todos-2wy2.toon))
- todos import --dry-run silently ignored \(still writes\) ([pm-todos-mn0f](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/issues/pm-todos-mn0f.toon))

## 2026.05.28 - 2026-05-28

### Added

- Add publish retry + provenance fallback to release workflow ([pm-todos-kxlz](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/tasks/pm-todos-kxlz.toon))

## 2026.05.27 - 2026-05-27

### Added

- Add bun-install verification to release workflow ([pm-todos-y5jp](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/tasks/pm-todos-y5jp.toon))

## 2026.05.26 - 2026-05-26

### Fixed

- Fix .gitignore + release workflow conflict for dist/ ([pm-todos-rx7k](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/tasks/pm-todos-rx7k.toon))
- ci: fix release workflow step ordering ([pm-todos-rh95](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/tasks/pm-todos-rh95.toon))

### Other

- Release readiness hardening for pm-todos ([pm-todos-8a8c](https://github.com/unbraind/pm-todos/blob/main/.agents/pm/tasks/pm-todos-8a8c.toon))
