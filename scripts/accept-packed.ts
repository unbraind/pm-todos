import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
}

/** Machine-readable proof emitted for one successful packed extension. */
interface AcceptanceReceipt {
  readonly scenario: string;
  readonly host_version: string;
  readonly imported: number;
  readonly exported_rows: number;
  readonly stderr_bytes: number;
  readonly fixtures_present: true;
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
  if (key.toLowerCase() === "npm_config_allow_scripts") delete cleanEnvironment[key];
}
/** Maximum time allowed for one install, pack, or pm subprocess. */
const commandTimeoutMs = 5 * 60 * 1000;

/** Run one shell-free command and fail with bounded diagnostics. */
function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = cleanEnvironment): SpawnSyncReturns<string> {
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
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${String(result.status)}: ${(result.stderr || result.error?.message || result.stdout).trim()}`);
  }
  return result;
}

/** Invoke the scenario-local pm host through its user-facing launcher. */
function runPm(scenario: AcceptanceScenario, cwd: string, env: NodeJS.ProcessEnv, args: string[]): SpawnSyncReturns<string> {
  return scenario.manager === "npm"
    ? run(npxCommand, ["--no-install", "pm", ...args], cwd, env)
    : run(bunxCommand, ["--no-install", "pm", ...args], cwd, env);
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
  // release:check runs a lifecycle-enabled pack dry-run immediately before this
  // gate. Ignore scripts here so prepare stdout cannot corrupt npm's JSON receipt.
  const packed = run(npmCommand, ["pack", "--json", "--ignore-scripts", "--pack-destination", packRoot], repoRoot);
  const packedEntries: unknown = JSON.parse(packed.stdout);
  const packedEntry = Array.isArray(packedEntries) && packedEntries.length === 1 ? packedEntries[0] : undefined;
  const packedName = packedEntry !== null && typeof packedEntry === "object"
    ? (packedEntry as Record<string, unknown>).filename
    : undefined;
  if (typeof packedName !== "string" || packedName.length === 0) {
    throw new Error(`npm pack must report exactly one tarball filename, got ${packed.stdout.trim()}`);
  }
  const tarball = join(packRoot, packedName);
  const scenarios: AcceptanceScenario[] = [
    { name: "npm-current", manager: "npm", hostVersion: developmentVersion },
    { name: "bun-current", manager: "bun", hostVersion: developmentVersion },
    { name: "npm-minimum", manager: "npm", hostVersion: minimumVersion },
  ];
  const receipts: AcceptanceReceipt[] = [];

  for (const scenario of scenarios) {
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
      PM_GLOBAL_PATH: join(scenarioRoot, "global-pm"),
      XDG_CONFIG_HOME: isolatedConfig,
      XDG_DATA_HOME: isolatedData,
      npm_config_cache: isolatedNpmCache,
      BUN_INSTALL_CACHE_DIR: isolatedBunCache,
    };
    if (scenario.manager === "npm") {
      run(npmCommand, ["init", "-y"], scenarioRoot, scenarioEnvironment);
      run(npmCommand, ["install", "--ignore-scripts", `${cliPackage}@${scenario.hostVersion}`, tarball], scenarioRoot, scenarioEnvironment);
    } else {
      run(bunCommand, ["init", "-y"], scenarioRoot, scenarioEnvironment);
      run(bunCommand, ["add", "--ignore-scripts", `${cliPackage}@${scenario.hostVersion}`, tarball], scenarioRoot, scenarioEnvironment);
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
    const titles = new Set(rows.map((row) => row.title));
    if (!titles.has(existingTitle) || !titles.has(importedTitle)) {
      throw new Error(`${scenario.name} complete export omitted a real tracker fixture`);
    }
    const stderr = `${imported.stderr}\n${exported.stderr}`;
    if (/deprecated|list-all/iu.test(stderr)) {
      throw new Error(`${scenario.name} emitted a deprecated-command diagnostic: ${stderr.trim()}`);
    }
    receipts.push({
      scenario: scenario.name,
      host_version: actualVersion,
      imported: importReceipt.imported as number,
      exported_rows: rows.length,
      stderr_bytes: Buffer.byteLength(stderr),
      fixtures_present: true,
    });
  }

  process.stdout.write(`${JSON.stringify({ ok: true, receipts })}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
