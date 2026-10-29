import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decodeToon } from "@unbrained/pm-cli/sdk/testing";

/** Package fields that define the installed-extension acceptance matrix. */
interface PackageContract {
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
}

/** One package-manager and host-version combination exercised in isolation. */
interface AcceptanceScenario {
  readonly name: string;
  readonly manager: "npm" | "bun";
  readonly hostVersion: string;
  readonly global?: boolean;
}

/** Machine-readable proof emitted for one successful packed extension. */
interface AcceptanceReceipt {
  readonly scenario: string;
  readonly host_version: string;
  readonly imported: number;
  readonly exported_rows: number;
  readonly stderr_bytes: number;
  readonly fixtures_present: true;
  readonly source_rows: number;
  readonly hierarchy_rows: number;
  readonly hierarchy_applied: number;
  readonly hierarchy_replay_changed: number;
  readonly hierarchy_prefix_safe: true;
  readonly extension_schema_safe: true;
  readonly source_replay_changed: number;
  readonly rollback_recovered: true;
  readonly copied_apply_refused: true;
  readonly recovery_format: "json" | "toon";
}

const repoRoot = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as PackageContract;
const cliPackage = "@unbrained/pm-cli";
const developmentVersion = packageJson.devDependencies[cliPackage];
const minimumMatch = packageJson.peerDependencies[cliPackage]?.match(/^>=\s*(\d+\.\d+\.\d+)$/u);
const minimumVersion = minimumMatch?.[1];
if (!developmentVersion || !/^\d+\.\d+\.\d+$/u.test(developmentVersion) || !minimumVersion) {
  throw new Error(`package.json must declare an exact development version and a >= exact minimum peer version for ${cliPackage}`);
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const bunCommand = process.platform === "win32" ? "bun.exe" : "bun";
const bunxCommand = process.platform === "win32" ? "bunx.exe" : "bunx";
const cleanEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  npm_config_userconfig: devNull,
  NPM_CONFIG_USERCONFIG: devNull,
  PM_TELEMETRY_DISABLED: "1",
};
for (const key of Object.keys(cleanEnvironment)) {
  if (key.toLowerCase() === "npm_config_allow_scripts" || /token|secret|password|credential|api.?key|private.?key|access.?key|^NPM_MEDIA_SERVER$/i.test(key)) delete cleanEnvironment[key];
}
/** Maximum time allowed for one install, pack, or pm subprocess. */
const commandTimeoutMs = 5 * 60 * 1000;

/** Run one shell-free command and fail with bounded diagnostics. */
function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = cleanEnvironment, expectedStatus = 0): SpawnSyncReturns<string> {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: commandTimeoutMs,
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    throw new Error(`${command} ${args.join(" ")} exceeded ${String(commandTimeoutMs)}ms and was terminated`);
  }
  if (result.status !== expectedStatus) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${String(result.status)}: ${(result.stderr || result.error?.message || result.stdout).trim()}`);
  }
  return result;
}

/** Invoke the scenario-local pm host through its user-facing launcher. */
function runPm(scenario: AcceptanceScenario, cwd: string, env: NodeJS.ProcessEnv, args: string[], expectedStatus = 0): SpawnSyncReturns<string> {
  if (scenario.global) return run(join(env.PM_ACCEPT_PREFIX!, "bin", process.platform === "win32" ? "pm.cmd" : "pm"), args, cwd, env, expectedStatus);
  return scenario.manager === "npm"
    ? run(npxCommand, ["--no-install", "pm", ...args], cwd, env, expectedStatus)
    : run(bunxCommand, ["--no-install", "pm", ...args], cwd, env, expectedStatus);
}

/** Require parseable object stdout from one installed command surface. */
function requireJsonObject(stdout: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(stdout);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} stdout was not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "pm-todos-packed-acceptance-"));
try {
  const packRoot = join(temporaryRoot, "pack");
  mkdirSync(packRoot);
  // npm 10 can emit lifecycle output on stdout during pack even when its
  // ignore-scripts controls are present. The fresh destination directory is a
  // stronger receipt than parsing that mixed human/machine output.
  run(
    npmCommand,
    ["pack", "--ignore-scripts", "--pack-destination", packRoot],
    repoRoot,
    { ...cleanEnvironment, npm_config_ignore_scripts: "true", NPM_CONFIG_IGNORE_SCRIPTS: "true" },
  );
  const packedNames = readdirSync(packRoot).filter((name) => name.endsWith(".tgz"));
  if (packedNames.length !== 1) {
    throw new Error(`npm pack must create exactly one tarball, got ${String(packedNames.length)}`);
  }
  const tarball = join(packRoot, packedNames[0]!);
  const scenarios: AcceptanceScenario[] = [
    { name: "npm-current", manager: "npm", hostVersion: developmentVersion },
    { name: "bun-current", manager: "bun", hostVersion: developmentVersion },
    { name: "npm-minimum", manager: "npm", hostVersion: minimumVersion },
    { name: "bun-minimum", manager: "bun", hostVersion: minimumVersion },
    { name: "npm-global", manager: "npm", hostVersion: "2026.10.28", global: true },
    { name: "bun-global", manager: "bun", hostVersion: "2026.10.28", global: true },
  ];
  const receipts: AcceptanceReceipt[] = [];

  const requested = process.argv[2];
  const selectedScenarios = requested ? scenarios.filter(scenario => scenario.name === requested) : scenarios;
  if (!selectedScenarios.length) throw new Error("Unknown packed acceptance scenario");
  for (const scenario of selectedScenarios) {
    const scenarioRoot = join(temporaryRoot, scenario.name);
    const isolatedConfig = join(scenarioRoot, "xdg-config");
    const isolatedData = join(scenarioRoot, "xdg-data");
    const isolatedNpmCache = join(scenarioRoot, "npm-cache");
    const isolatedBunCache = join(scenarioRoot, "bun-cache");
    mkdirSync(scenarioRoot);
    mkdirSync(isolatedConfig);
    mkdirSync(isolatedData);
    const scenarioEnvironment: NodeJS.ProcessEnv = {
      ...cleanEnvironment,
      // A linked pm test exports its own tracker path; each consumer must
      // initialize and exercise only its scenario-local tracker.
      PM_PATH: join(scenarioRoot, ".agents", "pm"),
      PM_GLOBAL_PATH: join(scenarioRoot, "global-pm"),
      XDG_CONFIG_HOME: isolatedConfig,
      XDG_DATA_HOME: isolatedData,
      npm_config_cache: isolatedNpmCache,
      BUN_INSTALL_CACHE_DIR: isolatedBunCache,
      BUN_INSTALL: join(scenarioRoot, "prefix"),
      // Bun exposes independent global package/bin destinations; pin both so
      // the consumer fixture never assumes they follow its install prefix.
      BUN_INSTALL_GLOBAL_DIR: join(scenarioRoot, "prefix", "install", "global"),
      BUN_INSTALL_BIN: join(scenarioRoot, "prefix", "bin"),
      PM_ACCEPT_PREFIX: join(scenarioRoot, "prefix"),
      GIT_CEILING_DIRECTORIES: temporaryRoot,
    };
    if (scenario.manager === "npm") {
      run(npmCommand, ["init", "-y"], scenarioRoot, scenarioEnvironment);
      run(npmCommand, ["install", "--ignore-scripts", ...(scenario.global ? ["--global", "--prefix", scenarioEnvironment.PM_ACCEPT_PREFIX!] : []), `${cliPackage}@${scenario.hostVersion}`, tarball], scenarioRoot, scenarioEnvironment);
    } else {
      const bunConfig = join(scenarioRoot, "accept-bunfig.toml");
      writeFileSync(bunConfig, `[install]\nglobalDir = ${JSON.stringify(scenarioEnvironment.BUN_INSTALL_GLOBAL_DIR)}\nglobalBinDir = ${JSON.stringify(scenarioEnvironment.BUN_INSTALL_BIN)}\n`);
      run(bunCommand, ["init", "-y"], scenarioRoot, scenarioEnvironment);
      run(bunCommand, ["add", `--config=${bunConfig}`, "--ignore-scripts", ...(scenario.global ? ["--global"] : []), `${cliPackage}@${scenario.hostVersion}`, tarball], scenarioRoot, scenarioEnvironment);
    }
    const actualVersion = runPm(scenario, scenarioRoot, scenarioEnvironment, ["--version"]).stdout.trim();
    if (actualVersion !== scenario.hostVersion) {
      throw new Error(`${scenario.name} resolved pm ${actualVersion}, expected ${scenario.hostVersion}`);
    }

    runPm(scenario, scenarioRoot, scenarioEnvironment, ["init", "--defaults", "--agent-guidance", "skip", "--prefix", "accept"]);
    const existingTitle = `Existing packed TODO ${scenario.name}`;
    runPm(scenario, scenarioRoot, scenarioEnvironment, ["create", "task", existingTitle, "--status", "open", "--create-mode", "progressive"]);
    runPm(scenario, scenarioRoot, scenarioEnvironment, ["install", tarball, "--project"]);
    const importedTitle = `Imported packed TODO ${scenario.name}`;
    const input = join(scenarioRoot, "TODO.md");
    const output = join(scenarioRoot, "export.jsonl");
    writeFileSync(input, `# TODO\n\n- [ ] ${importedTitle}\n`, "utf8");
    const imported = runPm(scenario, scenarioRoot, scenarioEnvironment, ["--json", "todos", "import", input, "--upsert"]);
    const importReceipt = requireJsonObject(imported.stdout, `${scenario.name} todos import`);
    if (importReceipt.imported !== 1 || importReceipt.updated !== 0 || importReceipt.skipped !== 0) {
      throw new Error(`${scenario.name} import receipt was unexpected: ${imported.stdout.trim()}`);
    }
    const exported = runPm(scenario, scenarioRoot, scenarioEnvironment, ["--json", "todos", "export", "--format", "jsonl", "--output", output]);
    const exportReceipt = requireJsonObject(exported.stdout, `${scenario.name} todos export`);
    if (exportReceipt.exported !== 2) {
      throw new Error(`${scenario.name} export receipt was unexpected: ${exported.stdout.trim()}`);
    }
    const rows = readFileSync(output, "utf8").split(/\r?\n/u).filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    if (rows.length !== exportReceipt.exported) {
      throw new Error(`${scenario.name} export file has ${String(rows.length)} rows but the receipt reports ${String(exportReceipt.exported)}`);
    }
    const titles = new Set(rows.map((row) => row.title));
    if (!titles.has(existingTitle) || !titles.has(importedTitle)) {
      throw new Error(`${scenario.name} complete export omitted a real tracker fixture`);
    }
    const stderr = `${imported.stderr}\n${exported.stderr}`;
    if (/deprecated|list-all/iu.test(stderr)) {
      throw new Error(`${scenario.name} emitted a deprecated-command diagnostic: ${stderr.trim()}`);
    }
    // Exercise the shipped hierarchy module through every global/local launcher.
    const hierarchySelection = join(scenarioRoot, "hierarchy-ids.json"), hierarchyFile = join(scenarioRoot, "hierarchy.md"), hierarchySession = join(scenarioRoot, "hierarchy.json");
    const hierarchyIds = rows.map(row => String(row.id));
    writeFileSync(hierarchySelection, JSON.stringify(hierarchyIds));
    const hierarchyArgs = ["--file", hierarchyFile, "--session", hierarchySession];
    const hierarchyExport = requireJsonObject(runPm(scenario, scenarioRoot, scenarioEnvironment, ["todos", "hierarchy", "export", "--selection", hierarchySelection, ...hierarchyArgs, "--json"]).stdout, "hierarchy export");
    if (hierarchyExport.selected !== 2) throw new Error("Packed hierarchy selection omitted an identity");
    const hierarchyLines = readFileSync(hierarchyFile, "utf8").trimEnd().split("\n");
    hierarchyLines[1] = "  " + hierarchyLines[1];
    writeFileSync(hierarchyFile, hierarchyLines.join("\r\n") + "\r\n");
    const hierarchyPreview = requireJsonObject(runPm(scenario, scenarioRoot, scenarioEnvironment, ["todos", "hierarchy", "preview", ...hierarchyArgs, "--json"]).stdout, "hierarchy preview");
    const hierarchyApply = requireJsonObject(runPm(scenario, scenarioRoot, scenarioEnvironment, ["todos", "hierarchy", "apply", ...hierarchyArgs, "--json"]).stdout, "hierarchy apply");
    const hierarchyReplay = requireJsonObject(runPm(scenario, scenarioRoot, scenarioEnvironment, ["todos", "hierarchy", "apply", ...hierarchyArgs, "--json"]).stdout, "hierarchy replay");
    if (hierarchyPreview.changed !== 1 || hierarchyApply.applied !== 1 || hierarchyReplay.changed !== 0) throw new Error("Packed hierarchy preview/apply/replay mismatch");
    const hierarchyChild = requireJsonObject(runPm(scenario, scenarioRoot, scenarioEnvironment, ["get", hierarchyIds[1]!, "--full", "--json"]).stdout, "hierarchy native read-back");
    if ((hierarchyChild.item as Record<string, unknown>).parent !== hierarchyIds[0]) throw new Error("Packed hierarchy relation did not persist");
    // A claimed prerequisite must stop the entire unsafe prefix, in JSON and
    // TOON, under every supported local/global package-manager consumer.
    const prefixDriverDirectory = join(scenarioEnvironment.PM_PATH!, "extensions", "pm-todos", ".accept-hierarchy");
    mkdirSync(prefixDriverDirectory);
    const prefixDriver = join(prefixDriverDirectory, "prefix.js");
    writeFileSync(prefixDriver, stripTypeScriptTypes(readFileSync(join(repoRoot, "scripts", "accept-hierarchy-prefix.ts"), "utf8")));
    const prefixFile = join(scenarioRoot, "prefix.md"), prefixSession = join(scenarioRoot, "prefix.json");
    const prefixDriverArgs = [prefixDriver, scenarioEnvironment.PM_PATH!, prefixFile, prefixSession];
    run(process.execPath, [...prefixDriverArgs, "seed"], scenarioRoot, scenarioEnvironment);
    const prefixArgs = ["--file", prefixFile, "--session", prefixSession];
    const prefixFormat = scenario.manager === "npm" ? ["--json"] : [];
    /** Decode either public output transport without a separate graph oracle. */
    const prefixReceipt = (stdout: string) => requireJsonObject(prefixFormat.length ? stdout : JSON.stringify(decodeToon(stdout)), "hierarchy prefix");
    const prefixPreview = prefixReceipt(runPm(scenario, scenarioRoot, scenarioEnvironment, ["todos", "hierarchy", "preview", ...prefixArgs, ...prefixFormat]).stdout);
    if (prefixPreview.ok !== true || prefixPreview.changed !== 2) throw new Error("Packed prefix preview failed");
    const prefixRefused = prefixReceipt(runPm(scenario, scenarioRoot, scenarioEnvironment, ["todos", "hierarchy", "apply", ...prefixArgs, ...prefixFormat], 1).stdout);
    if (prefixRefused.ok !== false || prefixRefused.applied !== 0 || (prefixRefused.refusals as Record<string, unknown>[])[0]?.code !== "native_refusal") throw new Error("Packed hierarchy persisted an unsafe prefix before ownership refusal");
    run(process.execPath, [...prefixDriverArgs, "verify-refused"], scenarioRoot, scenarioEnvironment);
    const prefixApplied = prefixReceipt(runPm(scenario, scenarioRoot, scenarioEnvironment, ["todos", "hierarchy", "apply", ...prefixArgs, ...prefixFormat]).stdout);
    if (prefixApplied.ok !== true || prefixApplied.applied !== 2) throw new Error("Packed safe prefix ordering failed");
    run(process.execPath, [...prefixDriverArgs, "verify-applied"], scenarioRoot, scenarioEnvironment);
    const selectionFile = join(scenarioRoot, "selection.json"), manifestFile = join(scenarioRoot, "sources.json");
    const edits = join(scenarioRoot, "edits"); mkdirSync(edits);
    const selectedIds = rows.map(row => String(row.id));
    writeFileSync(selectionFile, JSON.stringify({ sources: [{ file: "one.txt", ids: selectedIds }, { file: "two.txt", ids: [] }] }));
    const sourceArgs = ["--manifest", manifestFile, "--directory", edits];
    const sourceExport = requireJsonObject(runPm(scenario, scenarioRoot, scenarioEnvironment, ["todos", "sources", "export", "--selection", selectionFile, ...sourceArgs, "--json"]).stdout, "sources export");
    if (sourceExport.selected !== 2) throw new Error("Packed source export omitted selected rows");
    writeFileSync(join(edits, "two.txt"), readFileSync(join(edits, "one.txt")));
    writeFileSync(join(edits, "one.txt"), "");
    const sourcePreview = requireJsonObject(runPm(scenario, scenarioRoot, scenarioEnvironment, ["todos", "sources", "preview", ...sourceArgs, "--json"]).stdout, "sources preview");
    const sourceApply = requireJsonObject(runPm(scenario, scenarioRoot, scenarioEnvironment, ["todos", "sources", "apply", ...sourceArgs, "--json"]).stdout, "sources apply");
    const sourceReplay = requireJsonObject(runPm(scenario, scenarioRoot, scenarioEnvironment, ["todos", "sources", "apply", ...sourceArgs, "--json"]).stdout, "sources replay");
    if (sourcePreview.changed !== 2 || sourceApply.applied !== 2 || sourceReplay.changed !== 0) throw new Error("Packed cross-file move or replay failed");
    for (const id of selectedIds) {
      const read = requireJsonObject(runPm(scenario, scenarioRoot, scenarioEnvironment, ["get", id, "--full", "--json"]).stdout, "source SDK read-back");
      if ((read.item as Record<string, unknown>).todos_source_file !== "two.txt") throw new Error("Packed row ownership was not persisted");
    }
    // Interrupt the installed artifact after one native compensation, then
    // recover via the actual consumer CLI in both supported output formats.
    const recoveryDirectory = join(scenarioRoot, "recovery-edits"), recoveryManifest = join(scenarioRoot, "recovery-manifest.json");
    mkdirSync(recoveryDirectory);
    writeFileSync(selectionFile, JSON.stringify({ sources: [{ file: "one.txt", ids: [] }, { file: "two.txt", ids: selectedIds }] }));
    const recoveryArgs = ["--manifest", recoveryManifest, "--directory", recoveryDirectory];
    runPm(scenario, scenarioRoot, scenarioEnvironment, ["todos", "sources", "export", "--selection", selectionFile, ...recoveryArgs, "--json"]);
    writeFileSync(join(recoveryDirectory, "one.txt"), readFileSync(join(recoveryDirectory, "two.txt")));
    writeFileSync(join(recoveryDirectory, "two.txt"), "");
    // Use the host-managed artifact already installed above, independent of the
    // package manager's global storage layout. Its public loader supplies the SDK.
    const packageDirectory = join(scenarioEnvironment.PM_PATH!, "extensions", "pm-todos");
    const driverDirectory = join(packageDirectory, ".accept-recovery"); mkdirSync(driverDirectory);
    for (const name of ["interrupt-packed-source", "source-recovery-fixture"]) {
      const source = readFileSync(join(repoRoot, "scripts", name + ".ts"), "utf8");
      const javascript = stripTypeScriptTypes(source).replace('"./source-recovery-fixture.ts"', '"./source-recovery-fixture.js"');
      writeFileSync(join(driverDirectory, name + ".js"), javascript);
    }
    run(process.execPath, [join(driverDirectory, "interrupt-packed-source.js"), scenarioEnvironment.PM_PATH!, recoveryManifest, recoveryDirectory], scenarioRoot, scenarioEnvironment);
    const recoveryPreview = requireJsonObject(runPm(scenario, scenarioRoot, scenarioEnvironment, ["todos", "sources", "preview", ...recoveryArgs, "--json"]).stdout, "sources recovery preview");
    if (recoveryPreview.ok !== true || recoveryPreview.changed !== 1 || recoveryPreview.applied !== 0) throw new Error("Packed recovery preview rejected the native rollback lineage");
    const recoveryFormat = scenario.manager === "npm" ? "json" : "toon";
    const rawRecovery = runPm(scenario, scenarioRoot, scenarioEnvironment, ["todos", "sources", "apply", ...recoveryArgs, ...(recoveryFormat === "json" ? ["--json"] : [])]);
    const recovered = requireJsonObject(recoveryFormat === "json" ? rawRecovery.stdout : JSON.stringify(decodeToon(rawRecovery.stdout)), "sources rollback recovery");
    if (recovered.ok !== true || recovered.applied !== 2 || recovered.changed !== recoveryPreview.changed) throw new Error("Packed consumer could not finish rollback and retry its selection");
    for (const id of selectedIds) {
      const read = requireJsonObject(runPm(scenario, scenarioRoot, scenarioEnvironment, ["get", id, "--full", "--json"]).stdout, "recovered ownership read-back");
      if ((read.item as Record<string, unknown>).todos_source_file !== "one.txt") throw new Error("Recovered packed ownership was not persisted");
    }
    const poisonedDirectory = join(scenarioRoot, "foreign-edits"), poisonedManifest = join(scenarioRoot, "foreign-manifest.json");
    mkdirSync(poisonedDirectory);
    writeFileSync(selectionFile, JSON.stringify({ sources: [{ file: "one.txt", ids: selectedIds }, { file: "two.txt", ids: [] }] }));
    const poisonedArgs = ["--manifest", poisonedManifest, "--directory", poisonedDirectory];
    runPm(scenario, scenarioRoot, scenarioEnvironment, ["todos", "sources", "export", "--selection", selectionFile, ...poisonedArgs, "--json"]);
    writeFileSync(join(poisonedDirectory, "two.txt"), readFileSync(join(poisonedDirectory, "one.txt")));
    writeFileSync(join(poisonedDirectory, "one.txt"), "");
    const foreignDriverArgs = [join(driverDirectory, "interrupt-packed-source.js"), scenarioEnvironment.PM_PATH!, poisonedManifest, poisonedDirectory];
    run(process.execPath, [...foreignDriverArgs, "poison"], scenarioRoot, scenarioEnvironment);
    for (const action of ["preview", "apply"]) {
      const refused = runPm(scenario, scenarioRoot, scenarioEnvironment, ["todos", "sources", action, ...poisonedArgs, ...(recoveryFormat === "json" ? ["--json"] : [])], 1);
      const output = requireJsonObject(recoveryFormat === "json" ? refused.stdout : JSON.stringify(decodeToon(refused.stdout)), "copied apply refusal");
      const reason = (output.refusals as Record<string, unknown>[] | undefined)?.[0];
      if (output.ok !== false || output.applied !== 0 || reason?.code !== "stale_revision" || typeof reason.remedy !== "string" || !reason.remedy) throw new Error("Packed consumer accepted foreign ownership under a copied apply marker");
    }
    run(process.execPath, [...foreignDriverArgs, "verify-poison"], scenarioRoot, scenarioEnvironment);
    // The foreign bridge must remain in graph validation, and strict schema
    // reads/writes must retain fields contributed by another installed package.
    const schemaDriverDirectory = join(packageDirectory, ".accept-schema"); mkdirSync(schemaDriverDirectory);
    for (const name of ["accept-extension-schema", "extension-schema-fixture"]) {
      const source = readFileSync(join(repoRoot, "scripts", name + ".ts"), "utf8");
      writeFileSync(join(schemaDriverDirectory, name + ".js"), stripTypeScriptTypes(source).replace('"./extension-schema-fixture.ts"', '"./extension-schema-fixture.js"'));
    }
    const schemaFile = join(scenarioRoot, "schema"), schemaDriver = [join(schemaDriverDirectory, "accept-extension-schema.js"), scenarioEnvironment.PM_PATH!, schemaFile];
    run(process.execPath, [...schemaDriver, "seed"], scenarioRoot, scenarioEnvironment);
    const schemaFormat = scenario.manager === "npm" ? ["--json"] : [];
    /** Exercise the same strict-schema receipt in both installed output transports. */
    const schemaReceipt = (stdout: string) => requireJsonObject(schemaFormat.length ? stdout : JSON.stringify(decodeToon(stdout)), "extension schema");
    for (const action of ["preview", "apply"]) {
      const refused = schemaReceipt(runPm(scenario, scenarioRoot, scenarioEnvironment, ["todos", "hierarchy", action, "--file", schemaFile + ".blocked.md", "--session", schemaFile + ".blocked.json", ...schemaFormat], 1).stdout);
      if (refused.ok !== false || refused.applied !== 0 || (refused.refusals as Record<string, unknown>[])[0]?.code !== "cycle") throw new Error("Packed consumer omitted a registered bridge type from cycle validation");
    }
    run(process.execPath, [...schemaDriver, "verify-refused"], scenarioRoot, scenarioEnvironment);
    const schemaArgs = ["--file", schemaFile + ".parent.md", "--session", schemaFile + ".parent.json"];
    const schemaExport = schemaReceipt(runPm(scenario, scenarioRoot, scenarioEnvironment, ["todos", "hierarchy", "export", "--selection", schemaFile + ".ids.json", ...schemaArgs, ...schemaFormat]).stdout);
    if (schemaExport.selected !== 2 || schemaExport.skipped !== 0) throw new Error("Packed export refused valid registered foreign fields");
    writeFileSync(schemaFile + ".parent.md", readFileSync(schemaFile + ".edited"));
    const schemaPreview = schemaReceipt(runPm(scenario, scenarioRoot, scenarioEnvironment, ["todos", "hierarchy", "preview", ...schemaArgs, ...schemaFormat]).stdout);
    const schemaApply = schemaReceipt(runPm(scenario, scenarioRoot, scenarioEnvironment, ["todos", "hierarchy", "apply", ...schemaArgs, ...schemaFormat]).stdout);
    const schemaReplay = schemaReceipt(runPm(scenario, scenarioRoot, scenarioEnvironment, ["todos", "hierarchy", "apply", ...schemaArgs, ...schemaFormat]).stdout);
    if (schemaPreview.ok !== true || schemaPreview.changed !== 1 || schemaApply.ok !== true || schemaApply.applied !== 1 || schemaReplay.ok !== true || schemaReplay.changed !== 0) throw new Error("Packed strict-schema preview/apply/replay failed");
    run(process.execPath, [...schemaDriver, "verify-applied"], scenarioRoot, scenarioEnvironment);
    receipts.push({
      scenario: scenario.name,
      host_version: actualVersion,
      imported: importReceipt.imported as number,
      exported_rows: rows.length,
      stderr_bytes: Buffer.byteLength(stderr),
      fixtures_present: true,
      source_rows: selectedIds.length,
      hierarchy_rows: hierarchyIds.length,
      hierarchy_applied: hierarchyApply.applied as number,
      hierarchy_replay_changed: hierarchyReplay.changed as number,
      hierarchy_prefix_safe: true,
      extension_schema_safe: true,
      source_replay_changed: sourceReplay.changed as number,
      rollback_recovered: true,
      copied_apply_refused: true,
      recovery_format: recoveryFormat,
    });
  }

  process.stdout.write(`${JSON.stringify({ ok: true, artifact_sha256: createHash("sha256").update(readFileSync(tarball)).digest("hex"), receipts })}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
