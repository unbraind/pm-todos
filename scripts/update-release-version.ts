import { existsSync, readFileSync, writeFileSync } from "node:fs";

interface VersionedJson {
  version?: unknown;
  [key: string]: unknown;
}

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as VersionedJson;
if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
  throw new Error("package.json must contain a non-empty version");
}
const version = packageJson.version;

for (const file of ["manifest.json"]) {
  if (!existsSync(file)) continue;
  const json = JSON.parse(readFileSync(file, "utf8")) as VersionedJson;
  json.version = version;
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`, "utf8");
}

if (existsSync("index.ts")) {
  const source = readFileSync("index.ts", "utf8");
  const versionPattern = /version:\s*["'][^"']+["']/;
  if (!versionPattern.test(source)) {
    throw new Error("index.ts does not contain an extension version field");
  }
  writeFileSync("index.ts", source.replace(versionPattern, `version: "${version}"`), "utf8");
}

