import assert from "node:assert/strict";
import test from "node:test";

import extension from "../dist/index.js";

test("extension has required shape", () => {
  assert.ok(extension, "module should export a default value");
  assert.strictEqual(typeof extension, "object", "extension should be an object");
  assert.ok("name" in extension, "extension should have a name property");
  assert.ok("activate" in extension, "extension should have an activate method");
  assert.strictEqual(typeof extension.activate, "function", "activate should be a function");
});

test("extension registers commands plus the native todos importer and exporter", () => {
  const registered: string[] = [];
  const commands: string[] = [];
  const importers: string[] = [];
  const exporters: string[] = [];
  const noop = () => {};
  // Mirror the full ExtensionApi surface so activate() can register every
  // capability the extension uses (commands, importer, exporter). A partial
  // mock would throw TypeError when activate() calls a missing method.
  const api = {
    registerCommand: (command: { name?: string }) => {
      registered.push("command");
      if (command?.name) commands.push(command.name);
    },
    registerParser: noop, registerPreflight: noop, registerService: noop,
    registerFlags: noop, registerItemFields: noop, registerItemTypes: noop,
    registerMigration: noop, registerRenderer: noop,
    registerImporter: (name: string) => { registered.push("importer"); importers.push(name); },
    registerExporter: (name: string) => { registered.push("exporter"); exporters.push(name); },
    registerSearchProvider: noop, registerVectorStoreAdapter: noop,
    hooks: { beforeCommand: noop, afterCommand: noop, onWrite: noop, onRead: noop, onIndex: noop },
  };
  extension.activate(api as any);
  assert.ok(registered.length > 0, `extension should register at least one capability, got: ${JSON.stringify(registered)}`);
  assert.ok(commands.includes("todos context"), `should register 'todos context', got: ${JSON.stringify(commands)}`);
  assert.ok(commands.includes("todos sync"), `should register 'todos sync', got: ${JSON.stringify(commands)}`);
  assert.ok(importers.includes("todos"), `should register the native 'todos' importer, got: ${JSON.stringify(importers)}`);
  assert.ok(exporters.includes("todos"), `should register the native 'todos' exporter, got: ${JSON.stringify(exporters)}`);
});
