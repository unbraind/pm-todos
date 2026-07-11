import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("installed package preserves rich JSONL context through the pm store", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-todos-jsonl-"));
  const tracker = join(root, "tracker");
  const input = join(root, "input.jsonl");
  const output = join(root, "output.jsonl");
  const pmBin = join(process.cwd(), "node_modules", ".bin", "pm");
  const home = join(root, "home");
  const xdgConfig = join(root, "xdg-config");
  const xdgData = join(root, "xdg-data");
  mkdirSync(home);
  mkdirSync(xdgConfig);
  mkdirSync(xdgData);
  cpSync(join(process.cwd(), "test", "fixtures", "rich-roundtrip.jsonl"), input);
  const env = {
    ...process.env,
    HOME: home,
    PM_GLOBAL_PATH: join(root, "global-pm"),
    PM_TELEMETRY_DISABLED: "1",
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
  };
  const runPm = (args: string[]): string => execFileSync(pmBin, args, {
    cwd: root,
    env,
    encoding: "utf-8",
  });

  try {
    runPm(["init", tracker, "--json"]);
    runPm(["--pm-path", tracker, "install", process.cwd(), "--project", "--json"]);
    const doctor = JSON.parse(runPm(["--pm-path", tracker, "package", "doctor", "--project", "--detail", "deep", "--json"]));
    assert.deepEqual(doctor.warnings, []);
    assert.equal(doctor.details.deep.activation.registration_counts.item_fields, 5);

    runPm(["--pm-path", tracker, "todos", "import", input, "--format", "jsonl", "--upsert", "--json"]);
    runPm(["--pm-path", tracker, "todos", "export", "--format", "jsonl", "--output", output, "--json"]);
    runPm(["--pm-path", tracker, "todos", "sync", "--file", output, "--format", "jsonl", "--json"]);

    const parseJsonl = (path: string): Array<Record<string, unknown>> => readFileSync(path, "utf-8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const source = parseJsonl(input).map((item) => ({
      ...item,
      kv: Object.fromEntries(Object.entries(item.kv as Record<string, unknown>).map(
        ([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)],
      )),
    }));
    const exported = parseJsonl(output);
    assert.deepEqual(exported, source);

    const beforeRejectedSync = readFileSync(output, "utf-8");
    let rejected: unknown;
    try {
      runPm(["--pm-path", tracker, "todos", "sync", "--file", output, "--format", "jsonl", "--filter", "type=DefinitelyMissing", "--json"]);
    } catch (error) {
      rejected = error;
    }
    assert.ok(rejected, "sync should reject an empty result for a non-empty file");
    assert.match(String((rejected as { stderr?: unknown }).stderr), /Refusing to replace non-empty/);
    assert.equal(readFileSync(output, "utf-8"), beforeRejectedSync, "rejected sync must preserve the original file bytes");

    let missingFileError: unknown;
    try {
      runPm(["--pm-path", tracker, "todos", "sync", "--file", join(root, "missing.jsonl"), "--format", "jsonl", "--json"]);
    } catch (error) {
      missingFileError = error;
    }
    assert.ok(missingFileError, "sync should reject a missing source file");
    const missingStderr = String((missingFileError as { stderr?: unknown }).stderr);
    assert.match(missingStderr, /Failed to read sync file/);
    assert.match(missingStderr, /"exit_code": 3/);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
