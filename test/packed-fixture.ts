import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { devNull } from "node:os";
import { join } from "node:path";

/** Pack the built distribution into the fixture instead of scanning node_modules. */
export function packExtension(destination: string): string {
  const windows = process.platform === "win32";
  const env = {
    ...process.env,
    npm_config_userconfig: devNull,
    NPM_CONFIG_USERCONFIG: devNull,
    npm_config_ignore_scripts: "true",
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
  };
  execFileSync(windows ? "npm.cmd" : "npm", [
    "pack", "--ignore-scripts", "--pack-destination", destination,
  ], { cwd: process.cwd(), env, encoding: "utf8", shell: windows });
  const archives = readdirSync(destination).filter((name) => name.endsWith(".tgz"));
  assert.equal(archives.length, 1, "fixture must install exactly one packed artifact");
  return join(destination, archives[0]!);
}
