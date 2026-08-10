import assert from "node:assert/strict";
import test from "node:test";

import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension from "../index.ts";

/**
 * Activate pm-todos through pm's real host engine with the manifest's declared
 * capabilities.
 *
 * This deliberately replaces the hand-rolled `api` doubles these tests used to
 * build. A double accepts every registration unconditionally, so it cannot
 * observe host-side rejection — which is how `--json` flags that shadow a
 * host-owned global stayed green in CI while `todos validate` and `todos sync`
 * failed to register against a real pm host. The harness runs the same
 * validation the CLI runs, so an invalid registration fails the suite here.
 */
async function harness() {
  const created = await createExtensionTestHarness(extension, {
    name: "pm-todos",
    capabilities: ["commands", "schema", "importers", "preflight"],
  });
  assert.deepEqual(created.activation.failed, [], "activation must not fail");
  return created;
}

test("extension activates cleanly against the real pm host", async () => {
  const ext = await harness();
  assert.strictEqual(ext.name, "pm-todos");
  await ext.deactivate();
});

test("extension registers todos validate, context, and sync commands", async () => {
  const ext = await harness();

  ext.assertCommandContract({ name: "todos validate" });
  ext.assertCommandContract({ name: "todos context" });
  ext.assertCommandContract({ name: "todos sync" });

  await ext.deactivate();
});

test("extension registers the native todos importer, todos-import importer, and todos exporter", async () => {
  const ext = await harness();

  const { registrations } = ext.activation;
  assert.ok(
    registrations.importers.some((i) => i.importer === "todos"),
    "should register the 'todos' importer",
  );
  assert.ok(
    registrations.importers.some((i) => i.importer === "todos-import"),
    "should register the 'todos-import' importer",
  );
  assert.strictEqual(registrations.exporters.length, 1, "should register the 'todos' exporter");
  assert.strictEqual(registrations.exporters[0].exporter, "todos");

  await ext.deactivate();
});

test("extension registers schema item fields for TODO metadata", async () => {
  const ext = await harness();

  const { field: kvField } = ext.assertItemField({ name: "todos_kv", type: "object" });
  assert.strictEqual(kvField.optional, true, "todos_kv should be optional");

  const { field: createdField } = ext.assertItemField({ name: "todos_creation_date", type: "string" });
  assert.strictEqual(createdField.optional, true, "todos_creation_date should be optional");

  await ext.deactivate();
});

test("extension registers a preflight override", async () => {
  const ext = await harness();

  ext.assertPreflightOverride();

  await ext.deactivate();
});

/**
 * The preflight override must declare its command ownership STATICALLY.
 *
 * A runtime `ctx.command !== "todos import"` guard inside the callback scopes
 * dispatch but is invisible to anything that inspects the registration without
 * executing it. An unscoped registration is owned by every command, so the host
 * invokes it on every command and `pm health` reads it as contending with every
 * other extension that registers a preflight.
 *
 * Asserting the exact array rather than merely that it is non-empty is what
 * makes this test fail on a revert to the bare-callback form, where `commands`
 * is `undefined`.
 */
test("preflight override declares static command ownership of todos import", async () => {
  const ext = await harness();

  const override = ext.assertPreflightOverride({ extensionName: "pm-todos" });
  assert.deepEqual(
    override.commands,
    ["todos import"],
    "preflight ownership must be declared statically so the host scopes dispatch without running the callback",
  );

  await ext.deactivate();
});

test("todos sync declares its positional file argument and --file, --allow-empty flags", async () => {
  const ext = await harness();

  const { flags } = ext.assertCommandContract({
    name: "todos sync",
    flags: ["--file", "--allow-empty"],
  });
  const longs = flags.map((flag) => flag.long);
  assert.ok(longs.includes("--file"), "todos sync should declare its --file fallback");
  assert.ok(longs.includes("--allow-empty"), "todos sync should declare its destructive-empty override");

  await ext.deactivate();
});

test("todos validate declares --format", async () => {
  const ext = await harness();

  ext.assertCommandContract({ name: "todos validate", flags: ["--format"] });

  await ext.deactivate();
});

test("no command redeclares a host-owned global flag", async () => {
  // Guards the whole surface, not just the one command that regressed:
  // registering any of these makes the host reject the command outright, and
  // the value must be read from ctx.global instead.
  const hostOwned = new Set([
    "--json",
    "--quiet",
    "--path",
    "--lean",
    "--id-only",
    "--author",
    "--no-changed-fields",
    "--full-changed-fields",
    "--pm-path",
  ]);
  const ext = await harness();

  for (const registration of ext.activation.registrations.flags) {
    for (const flag of registration.flags) {
      assert.ok(
        flag.long === undefined || !hostOwned.has(flag.long),
        `${registration.target_command} must not redeclare host-owned global flag ${flag.long}`,
      );
    }
  }

  await ext.deactivate();
});