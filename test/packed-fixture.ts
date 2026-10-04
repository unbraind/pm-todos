import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { devNull } from "node:os";
import { dirname, join } from "node:path";

/** Describe the npm pack process so platform-specific argument handling is testable. */
export function packInvocation(destination: string, platform: string, environment: NodeJS.ProcessEnv): {
  executable: string;
  arguments: string[];
  shell: boolean;
} {
  const arguments_ = ["pack", "--ignore-scripts", "--pack-destination", destination];
  if (platform === "win32") {
    const entrypoint = environment.npm_execpath
      ?? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    return { executable: process.execPath, arguments: [entrypoint, ...arguments_], shell: false };
  }
  return {
    executable: "npm",
    arguments: arguments_,
    shell: false,
  };
}

/** Pack the built distribution into the fixture instead of scanning node_modules. */
export function packExtension(destination: string): string {
  const env = {
    ...process.env,
    npm_config_userconfig: devNull,
    NPM_CONFIG_USERCONFIG: devNull,
    npm_config_ignore_scripts: "true",
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
  };
  const invocation = packInvocation(destination, process.platform, env);
  execFileSync(invocation.executable, invocation.arguments, {
    cwd: process.cwd(), env, encoding: "utf8", shell: invocation.shell,
  });
  const archives = readdirSync(destination).filter((name) => name.endsWith(".tgz"));
  assert.equal(archives.length, 1, "fixture must install exactly one packed artifact");
  return join(destination, archives[0]!);
}
