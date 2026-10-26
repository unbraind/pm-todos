# Published pm SDK capability floor

Audited main: `a529b2d4b1cfe85e2f22fa0fa6843236b8766b40`. Required API floor: **2026.8.18**.

Declared host floor: `2026.10.20`. npm peer: `>=2026.10.20`.

floor verified: the host declaration and the npm peer or exact runtime dependency already cover every API below. No floor change is needed.

## Artifact method and limits

The published version list was obtained with `npm view @unbrained/pm-cli versions --json`. Each capability was bisected over stable published releases, with its first providing release and adjacent previous stable release inspected. Prereleases do not satisfy these stable npm minimum ranges. Tarballs were downloaded with `npm pack @unbrained/pm-cli@VERSION --ignore-scripts` into an isolated scratch directory and inspected as data. No downloaded pm package code or lifecycle script was executed.

Public module exports were checked against both `package.json` entrypoints and the static ESM runtime export graph, then their `dist` declarations. Client methods and context members were read from the published declarations, including inherited members and static methods. A context property is attributed to the context used by this package, rather than a later base-interface refactor. TypeScript symbol resolution covers aliases, typed lazy loaders, destructuring, and clients passed through helpers. Erased interfaces do not create runtime requirements; imported function/constructor types used by loaders are retained conservatively.

This establishes API availability. It does not attest older-host runtime semantics, provider integration, or execution on the declared minimum. The current pinned SDK remains the local test host.

## API to first-version table

The machine-readable source inventory and artifact hashes are in [sdk-floor.json](sdk-floor.json). Source locations refer to the audited main commit.

| Used API | First stable release | Previous stable release lacking it | Source uses |
| --- | --- | --- | --- |
| `@unbrained/pm-cli/sdk :: acquireLock` | 2026.5.14 | 2026.5.12 | [watcher.ts:7](../watcher.ts#L7) |
| `@unbrained/pm-cli/sdk :: certifyCompleteListResult` | 2026.8.18 | 2026.8.17 | [index.ts:11](../index.ts#L11) |
| `@unbrained/pm-cli/sdk :: create` | 2026.7.7 | 2026.7.6 | [recurrence.ts:3](../recurrence.ts#L3) |
| `@unbrained/pm-cli/sdk :: EXIT_CODE` | 2026.5.14 | 2026.5.12 | [watcher.ts:7](../watcher.ts#L7), [index.ts:11](../index.ts#L11) |
| `@unbrained/pm-cli/sdk :: getHistoryPath` | 2026.5.14 | 2026.5.12 | [recurrence.ts:3](../recurrence.ts#L3), [sessions.ts:3](../sessions.ts#L3) |
| `@unbrained/pm-cli/sdk :: inspectCompleteListResult` | 2026.8.18 | 2026.8.17 | [index.ts:11](../index.ts#L11) |
| `@unbrained/pm-cli/sdk :: listAllComplete` | 2026.8.18 | 2026.8.17 | [sessions.ts:3](../sessions.ts#L3), [watcher.ts:7](../watcher.ts#L7) |
| `@unbrained/pm-cli/sdk :: locateItem` | 2026.5.14 | 2026.5.12 | [recurrence.ts:3](../recurrence.ts#L3) |
| `@unbrained/pm-cli/sdk :: mutateItem` | 2026.7.23 | 2026.7.22 | [recurrence.ts:3](../recurrence.ts#L3), [sessions.ts:3](../sessions.ts#L3) |
| `@unbrained/pm-cli/sdk :: normalizeItemId` | 2026.5.14 | 2026.5.12 | [recurrence.ts:3](../recurrence.ts#L3) |
| `@unbrained/pm-cli/sdk :: PmClient` | 2026.7.6 | 2026.7.5 | [index.ts:11](../index.ts#L11) |
| `@unbrained/pm-cli/sdk :: readHistoryEntries` | 2026.7.15 | 2026.7.14 | [recurrence.ts:3](../recurrence.ts#L3), [sessions.ts:3](../sessions.ts#L3) |
| `@unbrained/pm-cli/sdk :: readLocatedItem` | 2026.5.14 | 2026.5.12 | [recurrence.ts:3](../recurrence.ts#L3) |
| `@unbrained/pm-cli/sdk :: readSettings` | 2026.5.14 | 2026.5.12 | [recurrence.ts:3](../recurrence.ts#L3), [sessions.ts:3](../sessions.ts#L3), [index.ts:11](../index.ts#L11) |
| `@unbrained/pm-cli/sdk :: replayHistoryToTarget` | 2026.7.15 | 2026.7.14 | [recurrence.ts:3](../recurrence.ts#L3) |
| `@unbrained/pm-cli/sdk :: resolveRuntimeStatusRegistry` | 2026.5.14 | 2026.5.12 | [recurrence.ts:3](../recurrence.ts#L3), [index.ts:11](../index.ts#L11) |
| `@unbrained/pm-cli/sdk :: serializeNdjsonRows` | 2026.7.24 | 2026.7.23 | [watcher.ts:7](../watcher.ts#L7) |
| `@unbrained/pm-cli/sdk :: SETTINGS_DEFAULTS` | 2026.7.23 | 2026.7.22 | [index.ts:11](../index.ts#L11) |
| `@unbrained/pm-cli/sdk :: statusIsTerminal` | 2026.7.23 | 2026.7.22 | [index.ts:11](../index.ts#L11) |
| `@unbrained/pm-cli/sdk :: suppressHostOutput` | 2026.7.15 | 2026.7.14 | [watcher.ts:7](../watcher.ts#L7) |
| `@unbrained/pm-cli/sdk :: verifyHistoryEntries` | 2026.7.24 | 2026.7.23 | [recurrence.ts:3](../recurrence.ts#L3), [sessions.ts:3](../sessions.ts#L3) |
| `@unbrained/pm-cli/sdk :: writeFileAtomic` | 2026.5.14 | 2026.5.12 | [watcher.ts:7](../watcher.ts#L7) |
| `CommandHandlerContext.args` | 2026.5.1 | 2026.3.12 | [index.ts:2808](../index.ts#L2808), [index.ts:2859](../index.ts#L2859), [index.ts:2860](../index.ts#L2860), [index.ts:2861](../index.ts#L2861), [index.ts:2905](../index.ts#L2905), [index.ts:3054](../index.ts#L3054), [index.ts:3493](../index.ts#L3493) |
| `CommandHandlerContext.global` | 2026.5.1 | 2026.3.12 | [index.ts:2904](../index.ts#L2904) |
| `CommandHandlerContext.options` | 2026.5.1 | 2026.3.12 | [watcher.ts:217](../watcher.ts#L217), [watcher.ts:219](../watcher.ts#L219), [watcher.ts:223](../watcher.ts#L223), [index.ts:1905](../index.ts#L1905), [index.ts:2809](../index.ts#L2809), [index.ts:2810](../index.ts#L2810), [index.ts:2860](../index.ts#L2860), [index.ts:2902](../index.ts#L2902), [index.ts:2970](../index.ts#L2970), [index.ts:2971](../index.ts#L2971), [index.ts:2972](../index.ts#L2972), [index.ts:2973](../index.ts#L2973), [index.ts:2980](../index.ts#L2980), [index.ts:3055](../index.ts#L3055), [index.ts:3066](../index.ts#L3066), [index.ts:3076](../index.ts#L3076), [index.ts:3080](../index.ts#L3080), [index.ts:3081](../index.ts#L3081), [index.ts:3082](../index.ts#L3082), [index.ts:3083](../index.ts#L3083), [index.ts:3084](../index.ts#L3084), [index.ts:3085](../index.ts#L3085), [index.ts:3087](../index.ts#L3087), [index.ts:3088](../index.ts#L3088), [index.ts:3089](../index.ts#L3089), [index.ts:3094](../index.ts#L3094), [index.ts:3122](../index.ts#L3122), [index.ts:3151](../index.ts#L3151), [index.ts:3152](../index.ts#L3152), [index.ts:3153](../index.ts#L3153), [index.ts:3154](../index.ts#L3154), [index.ts:3155](../index.ts#L3155), [index.ts:3156](../index.ts#L3156), [index.ts:3492](../index.ts#L3492), [index.ts:3494](../index.ts#L3494), [index.ts:3506](../index.ts#L3506) |
| `CommandHandlerContext.pm_root` | 2026.5.1 | 2026.3.12 | [watcher.ts:217](../watcher.ts#L217), [index.ts:1903](../index.ts#L1903), [index.ts:1905](../index.ts#L1905), [index.ts:2816](../index.ts#L2816), [index.ts:2839](../index.ts#L2839), [index.ts:2862](../index.ts#L2862), [index.ts:2863](../index.ts#L2863), [index.ts:2986](../index.ts#L2986), [index.ts:3120](../index.ts#L3120), [index.ts:3149](../index.ts#L3149), [index.ts:3498](../index.ts#L3498), [index.ts:3499](../index.ts#L3499) |
| `CommandHandlerContext.sdk` | 2026.7.19 | 2026.7.18 | [index.ts:1905](../index.ts#L1905) |
| `ExtensionApi.registerCommand` | 2026.5.1 | 2026.3.12 | [index.ts:2783](../index.ts#L2783), [index.ts:2799](../index.ts#L2799), [index.ts:2845](../index.ts#L2845), [index.ts:2881](../index.ts#L2881), [index.ts:2950](../index.ts#L2950), [index.ts:3014](../index.ts#L3014) |
| `ExtensionApi.registerExporter` | 2026.5.1 | 2026.3.12 | [index.ts:3387](../index.ts#L3387) |
| `ExtensionApi.registerImporter` | 2026.5.1 | 2026.3.12 | [index.ts:3379](../index.ts#L3379), [index.ts:3446](../index.ts#L3446) |
| `ExtensionApi.registerItemFields` | 2026.5.1 | 2026.3.12 | [index.ts:2869](../index.ts#L2869) |
| `ExtensionApi.registerPreflight` | 2026.5.1 | 2026.3.12 | [index.ts:3480](../index.ts#L3480) |
| `ExtensionCommandSdk.client` | 2026.7.19 | 2026.7.18 | [index.ts:1905](../index.ts#L1905) |
| `ImportExportContext.args` | 2026.5.1 | 2026.3.12 | [index.ts:3256](../index.ts#L3256) |
| `ImportExportContext.options` | 2026.5.1 | 2026.3.12 | [index.ts:3254](../index.ts#L3254), [index.ts:3255](../index.ts#L3255), [index.ts:3257](../index.ts#L3257), [index.ts:3278](../index.ts#L3278), [index.ts:3279](../index.ts#L3279), [index.ts:3280](../index.ts#L3280), [index.ts:3281](../index.ts#L3281), [index.ts:3282](../index.ts#L3282), [index.ts:3283](../index.ts#L3283), [index.ts:3285](../index.ts#L3285), [index.ts:3286](../index.ts#L3286), [index.ts:3287](../index.ts#L3287), [index.ts:3288](../index.ts#L3288), [index.ts:3309](../index.ts#L3309), [index.ts:3388](../index.ts#L3388), [index.ts:3389](../index.ts#L3389), [index.ts:3395](../index.ts#L3395), [index.ts:3396](../index.ts#L3396), [index.ts:3397](../index.ts#L3397), [index.ts:3398](../index.ts#L3398), [index.ts:3399](../index.ts#L3399), [index.ts:3400](../index.ts#L3400), [index.ts:3401](../index.ts#L3401) |
| `ImportExportContext.pm_root` | 2026.5.1 | 2026.3.12 | [index.ts:3262](../index.ts#L3262), [index.ts:3263](../index.ts#L3263), [index.ts:3307](../index.ts#L3307), [index.ts:3394](../index.ts#L3394) |
| `PmClient.create` | 2026.7.6 | 2026.7.5 | [index.ts:2580](../index.ts#L2580) |
| `PmClient.listAllComplete` | 2026.8.18 | 2026.8.17 | [index.ts:2300](../index.ts#L2300) |
| `PmClient.update` | 2026.7.6 | 2026.7.5 | [index.ts:2549](../index.ts#L2549) |
| `PreflightOverrideContext.decision` | 2026.5.1 | 2026.3.12 | [index.ts:3483](../index.ts#L3483) |

## Tarball provenance

SHA-256 of the exact packed `.tgz` bytes; package archives and extracted files are not committed.

| pm release | Tarball SHA-256 |
| --- | --- |
| 2026.3.12 | `4e4e6a33cb45d665f072120e9e1ce25d2e5773e738cbc914b29e8f54367747fb` |
| 2026.5.1 | `730de8b79aa0074dc2ca81a54ce37f9aaa0a4167b690c9a62b87d2121a8b37f7` |
| 2026.5.12 | `42dcaef84dc441b7792aeffa059bfe10a86ae8b12b1084472229bba03fb29910` |
| 2026.5.14 | `7f7e9131afadb891344bf2fb93b15bc157d18c532a5da4ec31677957d37b7260` |
| 2026.7.5 | `4a6664f68120cace5648faf48d51b08c14e969d9c7e185e592f1a0fceae57274` |
| 2026.7.6 | `0d6e446cf93a0f0660ce4e21943adf1e0c21381010ef67369f40cc9834b8d158` |
| 2026.7.7 | `c455dbda90d6f5aff55b23517683376ea6ab74d4a1540f3f8274590b1687c47e` |
| 2026.7.14 | `4a42de258a3b1cabff1112dd90ae4f3cc272e25ada229d818becae0f2845e128` |
| 2026.7.15 | `1c5d8e7427d74af157577ff58e0692a986016ee355eaf3a6b5ccebca5a9779aa` |
| 2026.7.18 | `44b48fe680cf330254a4ab8d42b55cbcee81ba5cf21e4d4550b40413265d64b9` |
| 2026.7.19 | `513e0aead42767a113a26b8b2e2cbb8a22879d0cb0500d4d3cdd16d21d9f7a39` |
| 2026.7.22 | `d013832d6afc97c9a5c6f4a48a497f54a216643f8c7017b9c4f807ce6607532b` |
| 2026.7.23 | `caf1a21b0b587dc55c3509654466dd1e20383e30f2d17b47678887a15a5490af` |
| 2026.7.24 | `ae7757c7e4b02bf5c0908a7bcfd487926912bc2f71332c68c9e1be4017d796ab` |
| 2026.8.17 | `fda330eb4887031751889ef85b510d52886fa5f70b4813f3951d7eed705023f2` |
| 2026.8.18 | `b00374f0e32c98ccec03a5893d8bfbbae45650f44bd04292ceafd8d9aac059f7` |
