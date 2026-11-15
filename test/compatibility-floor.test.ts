import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { parseDocument } from "yaml";

import { checkExtensionManifestCompatibility } from "@unbrained/pm-cli/sdk/authoring";

/** Package declarations enforced by npm and the release scripts. */
interface PackageManifest {
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly scripts?: Record<string, string>;
}

/** Untrusted compatibility field loaded from the raw extension manifest. */
interface ExtensionManifest {
  readonly pm_min_version?: unknown;
}

const repoRoot = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as PackageManifest;
const extensionManifest = JSON.parse(readFileSync(resolve(repoRoot, "manifest.json"), "utf8")) as ExtensionManifest;
const ciWorkflow = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
const releaseWorkflow = readFileSync(resolve(repoRoot, ".github/workflows/release.yml"), "utf8");
const packedAcceptance = readFileSync(resolve(repoRoot, "scripts/accept-packed.ts"), "utf8");
const cliPackage = "@unbrained/pm-cli";
const exactVersion = /^\d+\.\d+\.\d+$/u;
const minimumHost = "2026.10.23";

/** Compare unpadded calendar-version components numerically. */
function atOrAbove(pinned: string, floor: string): boolean {
  const floorParts = floor.split(".").map(Number);
  const pinnedParts = pinned.split(".").map(Number);
  const differing = floorParts.findIndex((part, index) => pinnedParts[index] !== part);
  return differing === -1 || pinnedParts[differing]! > floorParts[differing]!;
}

test("npm, the pm host, and development bind the same supported host floor", () => {
  const peer = packageJson.peerDependencies?.[cliPackage];
  const dev = packageJson.devDependencies?.[cliPackage];
  assert.match(peer ?? "", /^>=\d+\.\d+\.\d+$/u);
  assert.match(dev ?? "", exactVersion);
  assert.equal(peer, `>=${minimumHost}`);
  assert.equal(extensionManifest.pm_min_version, minimumHost);
  assert.ok(dev && atOrAbove(dev, minimumHost));
});

test("the complete raw manifest satisfies minimum and development SDK hosts", () => {
  const dev = packageJson.devDependencies?.[cliPackage];
  assert.ok(dev);
  for (const pmVersion of [minimumHost, dev]) {
    const result = checkExtensionManifestCompatibility(extensionManifest, { pmVersion });
    assert.equal(result.compatible, true, `manifest must accept pm ${pmVersion}`);
    assert.deepEqual(result.findings, [], `manifest must contain only SDK-supported keys on pm ${pmVersion}`);
  }
});

test("CI and release automation use the exact Node floor", () => {
  assert.match(ciWorkflow, /node-version:\s*\[22\.18\.0, 26\]/u);
  assert.match(ciWorkflow, /run:\s*npm run release:check/u);
  assert.match(releaseWorkflow, /node-version:\s*22\.18\.0/u);
});

test("every whole-tracker changelog read disables both universal output bounds", () => {
  for (const name of ["changelog", "changelog:full", "changelog:check", "release:notes"]) {
    const script = packageJson.scripts?.[name] ?? "";
    assert.match(script, /--pm-arg=--output-budget\s+--pm-arg=unbounded/u, `${name} must disable the token budget`);
    assert.match(script, /--pm-arg=--output-limit\s+--pm-arg=unbounded/u, `${name} must disable the row limit`);
    assert.match(script, /--pm-bin\s+\.\/node_modules\/\.bin\/pm/u, `${name} must use the pinned project host`);
  }
  assert.match(releaseWorkflow, /uses: unbraind\/pm-ops\/\.github\/workflows\/daily-release\.yml@[a-f0-9]{40}/u);
});

test("the mandatory release gate includes canonical-reader and packed-host acceptance", () => {
  assert.equal(packageJson.scripts?.["accept:canonical-reader"], "node scripts/accept-canonical-reader.ts");
  assert.equal(packageJson.scripts?.["accept:packed"], "node scripts/accept-packed.ts");
  assert.match(packageJson.scripts?.["release:check"] ?? "", /npm run accept:canonical-reader/u);
  assert.match(packageJson.scripts?.["release:check"] ?? "", /npm run accept:packed/u);
  for (const scenario of ["npm-current", "bun-current", "npm-minimum", "bun-minimum"]) {
    assert.match(packedAcceptance, new RegExp(`name: "${scenario}"`, "u"));
  }
});

test("calendar versions compare numerically rather than lexicographically", () => {
  assert.ok(atOrAbove("2026.8.20", "2026.8.20"));
  assert.ok(atOrAbove("2026.9.1", "2026.8.31"));
  assert.ok(!atOrAbove("2026.8.7", "2026.8.20"));
  assert.ok(atOrAbove("2027.1.1", "2026.12.31"));
});

/** Historical and item-less changed windows retain valid empty release sections. */
test("all changelog hooks explicitly allow empty sections for changed release windows", () => {
  for (const name of ["changelog:full", "changelog:check"]) {
    assert.match(packageJson.scripts?.[name] ?? "", /--all-release-tags --include-empty/u);
    assert.doesNotMatch(packageJson.scripts?.[name] ?? "", /--no-pending-release/u);
  }
  for (const name of ["changelog", "release:notes"]) {
    assert.match(packageJson.scripts?.[name] ?? "", /--include-empty/u);
  }
});

/** Bound each exhaustive job to one runtime gate while retaining both package managers. */
test("deep CI gives each Node and package-manager pair one release gate", () => {
  const document = parseDocument(readFileSync(resolve(repoRoot, ".github/workflows/ci-deep.yml"), "utf8"), { uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  const job = document.toJS().jobs.deep;
  assert.deepEqual(job.strategy.matrix["node-version"], ["22.18.0", 26]);
  assert.deepEqual(job.strategy.matrix["package-manager"], ["npm", "bun"]);
  for (const manager of ["npm", "bun"]) {
    const gate = job.steps.find((step: { run?: string }) => step.run === `${manager} run release:check`);
    assert.equal(gate.if, `matrix.package-manager == '${manager}'`);
  }
});
