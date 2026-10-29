/** Real tracker acceptance for reviewed checklist relationships, including replay and races. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import * as core from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { applyTodoHierarchy as apply, exportTodoHierarchy as checkout, parseTodoHierarchySession, type TodoHierarchyResult, type TodoHierarchyRelation } from "../index.ts";

/** Seed relationships and native fields outside git, with explicit relationship/scope values. */
async function fixture(t: test.TestContext, count = 5) {
  const root = mkdtempSync(join(tmpdir(), "todos-hierarchy-")), pmRoot = join(root, "tracker");
  const ceiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = dirname(root);
  t.after(() => { if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = ceiling; rmSync(root, { recursive: true, force: true }); });
  await core.init(undefined, {}, { pmRoot, cwd: root, noExtensions: true });
  const client = new core.PmClient({ pmRoot, cwd: root, author: "hierarchy-test" }), ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const result = await client.create({ id: `hierarchy-${index}`, title: index === 2 ? "Same title" : `Row ${index}`, type: "Task", parent: "none", sprint: "none", release: "none", blockedBy: "none", dep: [], priority: 2, tags: "fixture", description: "Retained description", body: "Retained body", comment: ["text=Original comment"], note: ["text=Original note"], file: ["path=example.ts"], doc: ["path=README.md"], test: ["command=node --version"], acceptanceCriteria: "Preserve relationships" });
    ids.push(result.item.id);
  }
  return { root, pmRoot, client, ids };
}
/** Build editor text independently from any package parser or normalization. */
function markdown(ids: string[], parents: (string | null)[], crlf = false): string {
  const lines: string[] = [];
  const walk = (id: string, depth: number) => {
    lines.push(`${"  ".repeat(depth)}- [ ] Same title <!-- pm-session:${id} -->`);
    for (const [i, child] of ids.entries()) if (parents[i] === id) walk(child, depth + 1);
  };
  for (const [i, id] of ids.entries()) if (parents[i] === null) walk(id, 0);
  return lines.join(crlf ? "\r\n" : "\n") + (crlf ? "\r\n" : "\n");
}
/** Full native model comparison comes from SDK get, including body and native fields. */
async function state(pmRoot: string, ids: string[]) {
  const settings = await core.readSettings(pmRoot);
  return Promise.all(ids.map(async id => {
    const located = await core.locateItem(pmRoot, id, settings.id_prefix, settings.item_format, core.resolveItemTypeRegistry(settings).type_to_folder);
    assert.ok(located);
    const { document } = await core.readLocatedItem(located, { schema: settings.schema });
    return { ...document.metadata, body: document.body };
  }));
}
/** Enforce the documented numeric output domains for every successful/refused operation. */
function counts(result: TodoHierarchyResult): void {
  for (const key of ["selected", "changed", "applied", "unchanged", "omittedChanges", "omittedAffected"] as const) assert.ok(Number.isSafeInteger(result[key]) && result[key] >= 0 && result[key] <= 1000, key);
  assert.ok(result.changes.length <= 40 && result.affected.length <= 40 && result.refusals.length <= 40);
}

test("reindenting a marked child proposes one parent change, with affected ancestors/children only and idempotent read-back", async t => {
  const f = await fixture(t);
  await f.client.update(f.ids[1], { parent: f.ids[0] });
  await f.client.update(f.ids[3], { parent: f.ids[1] });
  const exported = await checkout(f.pmRoot, f.ids.slice(0, 3));
  assert.deepEqual(parseTodoHierarchySession(JSON.parse(JSON.stringify(exported.session))), exported.session);
  const text = markdown(f.ids.slice(0, 3), [null, f.ids[2], null]);
  const before = await state(f.pmRoot, f.ids);
  const preview = await apply(f.pmRoot, exported.session, text, { author: "hierarchy-test", dryRun: true });
  assert.equal(preview.ok, true, JSON.stringify(preview)); counts(preview);
  assert.equal(preview.changed, 1); assert.deepEqual(preview.changes, [{ id: f.ids[1], relation: "parent", before: f.ids[0], after: f.ids[2] }]);
  assert.deepEqual(preview.affected, f.ids.slice(0, 4).sort()); assert.deepEqual(await state(f.pmRoot, f.ids), before);
  const result = await apply(f.pmRoot, exported.session, text, { author: "hierarchy-test" });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.applied, 1);
  assert.equal((await f.client.get(f.ids[1])).item.parent, f.ids[2]);
  const after = await state(f.pmRoot, f.ids), history = readFileSync(core.getHistoryPath(f.pmRoot, f.ids[1]), "utf8");
  const replay = await apply(f.pmRoot, exported.session, text.replaceAll("Same title", "Entirely different label").replaceAll("\n", "\r\n"), { author: "another-agent" });
  assert.equal(replay.ok, true, JSON.stringify(replay)); assert.equal(replay.changed, 0); assert.equal(replay.applied, 0);
  assert.deepEqual(await state(f.pmRoot, f.ids), after); assert.equal(readFileSync(core.getHistoryPath(f.pmRoot, f.ids[1]), "utf8"), history);
});

test("marked dependencies reuse native blocker updates; cycles and deleted parents refuse without writes", async t => {
  const f = await fixture(t);
  const exported = await checkout(f.pmRoot, f.ids.slice(0, 3), "blocked_by");
  const text = markdown(f.ids.slice(0, 3), [null, f.ids[0], null]);
  const applied = await apply(f.pmRoot, exported.session, text, { author: "hierarchy-test" });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const child = (await state(f.pmRoot, [f.ids[1]]))[0];
  assert.equal(child.blocked_by, f.ids[0]); assert.equal(child.dependencies?.[0].author_source, "asserted"); assert.ok(child.dependencies?.some(dep => dep.id === f.ids[0] && core.canonicalizeRelationshipKind(dep.kind) === "blocked_by"));
  assert.equal((await apply(f.pmRoot, exported.session, text, { author: "peer" })).changed, 0);
  const moveSession = await checkout(f.pmRoot, f.ids.slice(0, 3), "blocked_by");
  const moved = await apply(f.pmRoot, moveSession.session, markdown(f.ids.slice(0, 3), [null, f.ids[2], null]), { author: "hierarchy-test" });
  assert.equal(moved.ok, true, JSON.stringify(moved)); assert.equal(moved.changed, 1);
  const nativeChild = (await state(f.pmRoot, [f.ids[1]]))[0];
  assert.equal(nativeChild.blocked_by, f.ids[2]); assert.equal(nativeChild.dependencies?.length, 1); assert.equal(nativeChild.dependencies?.[0].id, f.ids[2]);
  // Restore this fixture's first blocker through a fresh reviewed repair.
  const restore = await checkout(f.pmRoot, f.ids.slice(0, 3), "blocked_by");
  assert.equal((await apply(f.pmRoot, restore.session, text, { author: "hierarchy-test" })).ok, true);

  const fresh = await checkout(f.pmRoot, f.ids.slice(0, 3), "blocked_by");
  await f.client.update(f.ids[2], { dep: [`id=${f.ids[0]},kind=blocks`] });
  const cycleSession = await checkout(f.pmRoot, f.ids.slice(0, 3), "blocked_by");
  const beforeCycle = await state(f.pmRoot, f.ids);
  const cycle = await apply(f.pmRoot, cycleSession.session, markdown(f.ids.slice(0, 3), [null, f.ids[0], f.ids[1]]), { author: "hierarchy-test" });
  assert.equal(cycle.refusals[0]?.code, "cycle", JSON.stringify(cycle)); assert.deepEqual(await state(f.pmRoot, f.ids), beforeCycle);
  const missing = await checkout(f.pmRoot, [f.ids[3], f.ids[4]]);
  await f.client.delete(f.ids[3], { reason: "Delete fixture parent" });
  const history = readFileSync(core.getHistoryPath(f.pmRoot, f.ids[4]), "utf8");
  const deleted = await apply(f.pmRoot, missing.session, markdown([f.ids[3], f.ids[4]], [null, f.ids[3]]), { author: "hierarchy-test" });
  assert.equal(deleted.refusals[0]?.code, "missing_item"); assert.equal(deleted.applied, 0); assert.equal(readFileSync(core.getHistoryPath(f.pmRoot, f.ids[4]), "utf8"), history);
  assert.equal((await apply(f.pmRoot, fresh.session, fresh.text, { author: "peer" })).refusals[0].code, "stale_revision");
});

test("orphans, ambiguous indentation, duplicate/unknown markers and native parent cycles are typed non-writing refusals", async t => {
  const f = await fixture(t), exported = await checkout(f.pmRoot, f.ids.slice(0, 3)), before = await state(f.pmRoot, f.ids);
  for (const [text, code] of [
    [exported.text.replace(`pm-session:${f.ids[1]}`, "pm-session:unknown"), "unknown_id"],
    [exported.text + exported.text.split("\n")[0] + "\n", "duplicate_id"],
    ["      " + exported.text, "ambiguous_indent"],
    [" " + exported.text, "ambiguous_indent"],
    ["\t" + exported.text, "orphan_row"],
    [exported.text.replace(/<!-- pm-session:[^>]+ -->/, ""), "orphan_row"],
    [exported.text.split("\n").slice(1).join("\n"), "orphan_row"],
  ]) {
    const preview = await apply(f.pmRoot, exported.session, text, { author: "hierarchy-test", dryRun: true });
    const result = await apply(f.pmRoot, exported.session, text, { author: "hierarchy-test" });
    assert.equal(result.refusals[0]?.code, code); assert.equal(preview.refusals[0]?.code, code); counts(result); assert.deepEqual(await state(f.pmRoot, f.ids), before);
  }
  await f.client.update(f.ids[2], { dep: [`id=${f.ids[1]},kind=child`] });
  const cycle = await checkout(f.pmRoot, f.ids.slice(0, 3));
  const result = await apply(f.pmRoot, cycle.session, markdown(f.ids.slice(0, 3), [null, null, f.ids[1]]), { author: "hierarchy-test" });
  assert.equal(result.ok, false); assert.equal(result.refusals[0].code, "cycle");
});

test("every apply boundary detects competing ordinary writers, including ABA and partial retry dependencies", async t => {
  for (const [boundary, occurrence] of [["planned", 1], ["before_write", 1], ["locked", 1], ["after_write", 1], ["before_write", 2], ["after_write", 2]] as const) {
    const f = await fixture(t), ids = f.ids.slice(0, 3), exported = await checkout(f.pmRoot, ids);
    const text = markdown(ids, [null, ids[0], ids[1]]);
    let injected = false, occurrences = 0;
    const result = await apply(f.pmRoot, exported.session, text, { author: "hierarchy-test", async onBoundary(at) {
      if (at !== boundary || ++occurrences !== occurrence || injected) return; injected = true;
      await f.client.update(ids[2], { title: "Peer temporary" }); await f.client.update(ids[2], { title: "Row 2" });
    } });
    assert.ok(injected); assert.equal(result.ok, false, boundary); assert.equal(result.refusals[0].code, "stale_revision");
    assert.equal((await f.client.get(ids[2])).item.parent, boundary === "after_write" && occurrence === 2 ? ids[1] : undefined);
    assert.equal(result.applied, boundary === "after_write" ? occurrence : occurrence - 1);
    const before = await state(f.pmRoot, f.ids);
    const retry = await apply(f.pmRoot, exported.session, text, { author: "hierarchy-test" });
    assert.equal(retry.refusals[0].code, "stale_revision"); assert.equal(retry.applied, 0); assert.deepEqual(await state(f.pmRoot, f.ids), before);
  }
});

test("extreme untrusted inputs refuse before SDK use; old titles and invalid records stay readable", async t => {
  const f = await fixture(t), exported = await checkout(f.pmRoot, f.ids);
  const bad = [null, Infinity, -Infinity, NaN, 1e300, -1, [], Array(2), [1], {}, "", "x".repeat(1024 * 1024 + 1)];
  for (const value of bad) {
    const result = await apply("unavailable", value, exported.text, { author: "test" }); assert.equal(result.ok, false); counts(result);
    const text = await apply("unavailable", exported.session, value, { author: "test" }); assert.equal(text.ok, false); counts(text);
  }
  const corrupt = { ...exported.session, digest: "a".repeat(64) };
  assert.equal((await apply(f.pmRoot, corrupt, exported.text, { author: "test" })).refusals[0].code, "invalid_session");
  const hidden = Object.defineProperty({ ...exported.session }, "rows", { enumerable: false, value: exported.session.rows });
  const accessor = Object.defineProperty({}, "version", { enumerable: true, get() { throw new Error("Executed accessor"); } });
  for (const value of [hidden, accessor, { ...exported.session, rows: Array(4) }, { ...exported.session, rows: Object.assign([...exported.session.rows], { extra: true }) }]) assert.equal((await apply("unavailable", value, "", { author: "test" })).ok, false);
  assert.equal((await apply(f.pmRoot, exported.session, exported.text, { author: "" })).ok, false);
  assert.equal((await apply(f.pmRoot, exported.session, exported.text, { author: "test", dryRun: 1 as unknown as boolean })).ok, false);
  await assert.rejects(checkout("unavailable", Array(2)));
  await assert.rejects(checkout("unavailable", [f.ids[0], f.ids[0]]));
  await assert.rejects(checkout("unavailable", [f.ids[0]], "unknown" as TodoHierarchyRelation));
  await f.client.update(f.ids[0], { title: "Legacy: title +tag @context [Feature]" });
  assert.ok((await checkout(f.pmRoot, f.ids)).text.includes("Legacy: title"));
  await f.client.update(f.ids[0], { title: "Multi\nline" });
  await f.client.update(f.ids[1], { parent: f.ids[0] });
  const partial = await checkout(f.pmRoot, f.ids);
  assert.equal(partial.skipped, 2); assert.equal(partial.session.rows.length, 3);
  assert.ok(partial.refusals.some(row => row.code === "orphan_row" && row.id === f.ids[1]));
});

test("500 seeded operation sequences compare SDK state with an independent relationship model under random status registries and ambient focus", { timeout: 1200000 }, async t => {
  let seed = 0x48594552;
  const random = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  const operations = new Set<number>();
  for (let cohort = 0; cohort < 10; cohort++) {
    const f = await fixture(t, 4), ids = f.ids.slice(0, 3), relation: TodoHierarchyRelation = cohort % 2 ? "blocked_by" : "parent";
    for (let index = 0; index < 4; index++) {
      const name = `state-${random(100000000)}`;
      const role = index === 0 ? ["active"] : index === 1 ? ["blocked"] : index === 2 ? ["terminal", "terminal_done"] : ["terminal", "terminal_canceled"];
      await f.client.schemaAddStatus(name, { role });
      await f.client.update(f.ids[index], { status: name, ...(index > 1 ? { closeReason: "Model lifecycle fixture" } : {}) });
    }
    // Full native snapshots define the independent preservation model. Only these
    // exact valid relationship values change; no package parser normalizes expectations.
    const statusExport = await checkout(f.pmRoot, f.ids, relation);
    for (const index of [2, 3]) assert.ok(statusExport.text.split("\n").some(line => line.includes(`pm-session:${f.ids[index]}`) && line.includes("[x]")));
    const expected = new Map((await state(f.pmRoot, f.ids)).map(item => [item.id, structuredClone(item)]));
    let targets: (string | null)[] = [null, null, null];
    let older: Awaited<ReturnType<typeof checkout>> | undefined;
    for (let sequence = 0; sequence < 50; sequence++) {
      const exported = await checkout(f.pmRoot, ids, relation);
      parseTodoHierarchySession(JSON.parse(JSON.stringify(exported.session)));
      const op = (random(9) + sequence) % 9; operations.add(op);
      const proposed = [...targets];
      if (op < 3) proposed[1 + random(2)] = random(2) ? ids[0] : null;
      const text = markdown(ids, proposed, sequence % 2 === 0).replaceAll("Same title", sequence % 3 ? "  Similar  titles  " : "__proto__ constructor: old title");
      await f.client.focus(f.ids[random(f.ids.length)]);
      const snapshotBefore = await state(f.pmRoot, f.ids);
      const preview = await apply(f.pmRoot, exported.session, text, { author: "model-agent", dryRun: true });
      assert.equal(preview.ok, true, JSON.stringify(preview)); counts(preview);
      assert.deepEqual(await state(f.pmRoot, f.ids), snapshotBefore);
      const result = await apply(f.pmRoot, exported.session, text, { author: "model-agent" });
      assert.equal(result.ok, true, `${cohort}/${sequence}/${op}: ${JSON.stringify(result)}`); assert.equal(result.changed, preview.changed); counts(result);
      const readBack = await state(f.pmRoot, f.ids);
      for (const item of readBack) {
        const wanted = expected.get(item.id)!;
        const index = ids.indexOf(item.id), desired = index >= 0 ? proposed[index] : null;
        if (index >= 0) {
          if (desired) wanted[relation] = desired; else delete wanted[relation];
        }
        for (const key of new Set([...Object.keys(wanted), ...Object.keys(item)])) {
          if (key === "updated_at") {
            const history = await core.readHistoryEntries(core.getHistoryPath(f.pmRoot, item.id), item.id);
            assert.equal(item.updated_at, history.at(-1)?.ts);
            continue;
          }
          if (relation === "blocked_by" && key === "dependencies" && index >= 0) {
            const edges = item.dependencies ?? [];
            assert.equal(edges.length, desired ? 1 : 0);
            if (desired) { assert.equal(edges[0].id, desired); assert.equal(edges[0].kind, "blocked_by"); assert.equal(edges[0].author, "model-agent"); assert.equal(edges[0].source_kind, "pm-todos:hierarchy"); assert.equal(edges[0].author_source, "asserted"); assert.deepEqual(Object.keys(edges[0]).sort(), ["author", "author_source", "created_at", "id", "kind", "source_kind"]); assert.ok(Number.isFinite(Date.parse(edges[0].created_at!))); }
            continue;
          }
          assert.deepEqual((item as unknown as Record<string, unknown>)[key], (wanted as unknown as Record<string, unknown>)[key], `${cohort}/${sequence}: ${key}`);
        }
      }
      targets = proposed;
      const after = await state(f.pmRoot, f.ids);
      const replay = await apply(f.pmRoot, exported.session, text, { author: "other-agent" });
      assert.equal(replay.ok, true, JSON.stringify(replay)); assert.equal(replay.changed, 0); assert.equal(replay.applied, 0); counts(replay); assert.deepEqual(await state(f.pmRoot, f.ids), after);
      if (older && op === 4) {
        const old = await apply(f.pmRoot, older.session, older.text, { author: "replay-agent" });
        assert.equal(old.applied, 0); counts(old); assert.deepEqual(await state(f.pmRoot, f.ids), after);
      }
      if (op === 5) {
        const malformed = await apply(f.pmRoot, exported.session, "    " + text, { author: "model-agent" });
        assert.equal(malformed.ok, false); assert.deepEqual(await state(f.pmRoot, f.ids), after);
      }
      if (op === 6) {
        const reordered = text.split(/\r?\n/).filter(Boolean);
        if (targets.every(value => value === null)) {
          const reorderedResult = await apply(f.pmRoot, exported.session, reordered.reverse().join("\n") + "\n", { author: "model-agent" });
          assert.equal(reorderedResult.ok, true); assert.equal(reorderedResult.changed, 0);
        }
      }
      if (op === 7) {
        // New history with equal content must invalidate the old revision (ABA).
        await f.client.update(ids[0], { title: "Transient peer edit" });
        await f.client.update(ids[0], { title: String(expected.get(ids[0])!.title) });
        const stale = await apply(f.pmRoot, exported.session, text, { author: "model-agent" });
        assert.equal(stale.refusals[0].code, "stale_revision"); assert.equal(stale.applied, 0);
      }
      if (!older && result.changed) older = structuredClone(exported);
    }
    t.diagnostic(`${(cohort + 1) * 50} seeded sequences verified`);
  }
  assert.equal(operations.size, 9);
});

test("CLI transport uses the same planner and redacts invalid inputs; files never overwrite peer edits", async t => {
  const f = await fixture(t), h = await createExtensionTestHarness(extension, { name: "pm-todos", capabilities: ["commands", "schema", "importers", "preflight"] });
  t.after(() => { process.exitCode = 0; });
  const file = join(f.root, "checklist.md"), session = join(f.root, "hierarchy.json"), selection = join(f.root, "ids.json");
  writeFileSync(selection, JSON.stringify(f.ids.slice(0, 3)));
  const run = (action: string, options: Record<string, unknown>) => h.runCommand({ command: "todos hierarchy", args: [action], options, pmRoot: f.pmRoot });
  await run("export", { file, session, selection });
  writeFileSync(file, markdown(f.ids.slice(0, 3), [null, f.ids[0], null]));
  const before = await state(f.pmRoot, f.ids);
  assert.ok(await run("preview", { file, session })); assert.deepEqual(await state(f.pmRoot, f.ids), before);
  assert.ok(await run("apply", { file, session })); assert.equal((await f.client.get(f.ids[1])).item.parent, f.ids[0]);
  for (const options of [{}, { file, session: file }, { file, session, selection }, { file, session, relation: "bad" }, { file: " ", session }, { file: selection, session }]) {
    await run("preview", options); assert.equal(process.exitCode, 1); process.exitCode = 0;
  }
  await run("export", { file, session, selection }); assert.equal(process.exitCode, 1); process.exitCode = 0;
  const partial = join(f.root, "partial.json");
  await run("export", { file, session: partial, selection }); assert.equal(process.exitCode, 1); process.exitCode = 0; assert.ok(readFileSync(partial, "utf8").includes("digest"));
  rmSync(file); symlinkSync(selection, file);
  await run("preview", { file, session }); assert.equal(process.exitCode, 1); process.exitCode = 0;
});

test("peer completion at every boundary is reported truthfully; unrelated native dependency annotations survive parent edits", async t => {
  for (const boundary of ["planned", "before_write", "after_write"] as const) {
    const f = await fixture(t), ids = f.ids.slice(0, 3);
    await f.client.update(ids[1], { dep: [`id=${f.ids[4]},kind=related`] });
    const retained = (await state(f.pmRoot, [ids[1]]))[0].dependencies;
    const exported = await checkout(f.pmRoot, ids), text = markdown(ids, [null, ids[0], null]);
    let peer: TodoHierarchyResult | undefined;
    const receipt = await apply(f.pmRoot, exported.session, text, { author: "first-agent", async onBoundary(at) {
      if (at === boundary && !peer) peer = await apply(f.pmRoot, exported.session, text, { author: "peer-agent" });
    } });
    assert.equal(receipt.ok, true, JSON.stringify(receipt)); assert.equal(peer?.ok, true); assert.equal(receipt.applied + peer!.applied, 1);
    assert.deepEqual((await state(f.pmRoot, [ids[1]]))[0].dependencies, retained);
  }
});

test("built CLI works without git and detects an ordinary OS-process writer before applying", async t => {
  const f = await fixture(t, 2), bin = join(f.root, "bin"), repo = resolve(import.meta.dirname, "..");
  mkdirSync(bin); symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync(join(repo, "node_modules"), join(f.root, "node_modules"), "dir");
  const extensionPath = join(f.pmRoot, "extensions", "pm-todos"); mkdirSync(extensionPath, { recursive: true });
  cpSync(join(repo, "dist"), join(extensionPath, "dist"), { recursive: true }); cpSync(join(repo, "manifest.json"), join(extensionPath, "manifest.json"));
  const childEnvironment: NodeJS.ProcessEnv = { ...process.env, PATH: bin, HOME: f.root, GIT_CEILING_DIRECTORIES: dirname(f.root), PM_AUTHOR: "process-peer" };
  for (const key of Object.keys(childEnvironment)) if (/token|secret|password|credential|api.?key|private.?key|access.?key|^NPM_MEDIA_SERVER$/i.test(key)) delete childEnvironment[key];
  const pm = (args: string[]) => spawnSync(process.execPath, [join(repo, "node_modules/@unbrained/pm-cli/dist/cli.js"), "--pm-path", f.pmRoot, ...args], { cwd: f.root, env: childEnvironment, encoding: "utf8", timeout: 60000 });
  const selection = join(f.root, "ids.json"), file = join(f.root, "checklist.md"), session = join(f.root, "baseline.json");
  writeFileSync(selection, JSON.stringify(f.ids));
  const exported = pm(["todos", "hierarchy", "export", "--selection", selection, "--file", file, "--session", session, "--json"]);
  assert.equal(exported.status, 0, exported.stderr + exported.stdout); assert.equal(JSON.parse(exported.stdout).selected, 2);
  writeFileSync(file, markdown(f.ids, [null, f.ids[0]]));
  const args = ["--file", file, "--session", session];
  const preview = pm(["todos", "hierarchy", "preview", ...args, "--json"]); assert.equal(preview.status, 0, preview.stderr + preview.stdout); assert.equal(JSON.parse(preview.stdout).changed, 1);
  const input = JSON.parse(readFileSync(session, "utf8")) as unknown;
  const refused = await apply(f.pmRoot, input, readFileSync(file, "utf8"), { author: "hierarchy-test", onBoundary(boundary) {
    if (boundary === "before_write") {
      const peer = pm(["update", f.ids[0], "--description", "Peer before relation write", "--json"]);
      assert.equal(peer.status, 0, peer.stderr + peer.stdout);
    }
  } });
  assert.equal(refused.refusals[0].code, "stale_revision"); assert.equal(refused.applied, 0);
  const freshSession = join(f.root, "fresh.json"), freshFile = join(f.root, "fresh.md");
  assert.equal(pm(["todos", "hierarchy", "export", "--selection", selection, "--file", freshFile, "--session", freshSession, "--json"]).status, 0);
  writeFileSync(freshFile, markdown(f.ids, [null, f.ids[0]]));
  const applied = pm(["todos", "hierarchy", "apply", "--file", freshFile, "--session", freshSession]);
  assert.equal(applied.status, 0, applied.stderr + applied.stdout); assert.match(applied.stdout, /applied: 1/);
  assert.equal((await f.client.get(f.ids[1])).item.parent, f.ids[0]);
});

test("large previews bound changes and affected output while excluding unrelated rows", async t => {
  const f = await fixture(t, 53), ids = f.ids.slice(0, 51);
  const exported = await checkout(f.pmRoot, ids);
  const text = markdown(ids, ids.map((_,index) => index ? ids[0] : null));
  const before = await state(f.pmRoot, f.ids);
  const preview = await apply(f.pmRoot, exported.session, text, { author: "hierarchy-test", dryRun: true });
  assert.equal(preview.ok, true, JSON.stringify(preview)); counts(preview);
  assert.equal(preview.changed, 50); assert.equal(preview.changes.length, 40); assert.equal(preview.omittedChanges, 10);
  assert.equal(preview.affected.length, 40); assert.equal(preview.omittedAffected, 11); assert.deepEqual(await state(f.pmRoot, f.ids), before);
});

test("native corruption skips only its export row and denies application without rewriting history", async t => {
  const f = await fixture(t, 3), exported = await checkout(f.pmRoot, f.ids);
  const path = core.getHistoryPath(f.pmRoot, f.ids[1]), original = readFileSync(path, "utf8");
  writeFileSync(path, original.replace(/"record_hash":"[a-f0-9]+"/, '"record_hash":"' + "0".repeat(64) + '"'));
  const damaged = readFileSync(path, "utf8");
  const result = await apply(f.pmRoot, exported.session, markdown(f.ids, [null, f.ids[0], null]), { author: "hierarchy-test" });
  assert.equal(result.refusals[0].code, "invalid_history"); assert.equal(result.applied, 0); assert.equal(readFileSync(path, "utf8"), damaged);
  const partial = await checkout(f.pmRoot, f.ids); assert.equal(partial.skipped, 1); assert.equal(partial.session.rows.length, 2);
  writeFileSync(path, "Unreadable native history\n");
  const unreadable = await checkout(f.pmRoot, f.ids); assert.equal(unreadable.skipped, 1); assert.equal(unreadable.session.rows.length, 2);
});

test("retry after interruption revalidates every current target and finishes only remaining relations", async t => {
  for (const stopAfter of [1, 2]) {
    const f = await fixture(t, 3), exported = await checkout(f.pmRoot, f.ids), text = markdown(f.ids, [null, f.ids[0], f.ids[1]]);
    let writes = 0;
    const interrupted = await apply(f.pmRoot, exported.session, text, { author: "hierarchy-test", onBoundary(boundary) {
      if (boundary === "after_write" && ++writes === stopAfter) throw new Error("Injected interruption");
    } });
    assert.equal(interrupted.ok, false); assert.equal(interrupted.applied, stopAfter);
    const retry = await apply(f.pmRoot, exported.session, text, { author: "recovery-agent" });
    assert.equal(retry.ok, true, JSON.stringify(retry)); assert.equal(retry.applied, 2 - stopAfter);
    const beforeReplay = await state(f.pmRoot, f.ids);
    const replay = await apply(f.pmRoot, exported.session, text, { author: "recovery-agent" });
    assert.equal(replay.ok, true); assert.equal(replay.changed, 0); assert.deepEqual(await state(f.pmRoot, f.ids), beforeReplay);
  }
});

test("multiple blockers are skipped individually and never flattened by export", async t => {
  const f = await fixture(t, 3);
  await f.client.update(f.ids[1], { dep: [`id=${f.ids[0]},kind=blocked_by`, `id=${f.ids[2]},kind=blocked_by`] });
  const before = await state(f.pmRoot, f.ids), exported = await checkout(f.pmRoot, f.ids, "blocked_by");
  assert.equal(exported.skipped, 1); assert.equal(exported.refusals[0].id, f.ids[1]); assert.equal(exported.session.rows.length, 2);
  assert.deepEqual(await state(f.pmRoot, f.ids), before);
});

test("native ownership still refuses a relation edit held by a peer", async t => {
  const f = await fixture(t, 2);
  await f.client.config("project", "set", "governance-ownership-enforcement", "strict");
  await f.client.claim(f.ids[1], { author: "peer-owner" });
  const exported = await checkout(f.pmRoot, f.ids), before = await state(f.pmRoot, f.ids);
  const result = await apply(f.pmRoot, exported.session, markdown(f.ids, [null, f.ids[0]]), { author: "hierarchy-test" });
  assert.equal(result.ok, false); assert.equal(result.applied, 0); assert.equal(result.refusals[0].code, "native_refusal");
  assert.deepEqual(await state(f.pmRoot, f.ids), before);
});


test("hierarchy row parsing refuses a million-space adversarial row in bounded time", async t => {
  const f = await fixture(t, 1), exported = await checkout(f.pmRoot, f.ids);
  const module = pathToFileURL(resolve(import.meta.dirname, "../hierarchy.ts")).href;
  const script = `import {applyTodoHierarchy} from ${JSON.stringify(module)};
const receipt = await applyTodoHierarchy(process.argv[1], JSON.parse(process.argv[2]), '- [ ] a' + ' '.repeat(1000000) + '!', {author:'parser-test',dryRun:true});
process.stdout.write(JSON.stringify(receipt));`;
  const childEnvironment: NodeJS.ProcessEnv = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(f.root) };
  for (const key of Object.keys(childEnvironment)) if (/token|secret|password|credential|api.?key|private.?key|access.?key|^NPM_MEDIA_SERVER$/i.test(key)) delete childEnvironment[key];
  const result = spawnSync(process.execPath, ["--no-enable-experimental-regexp-engine-on-excessive-backtracks", "--input-type=module", "-e", script, f.pmRoot, JSON.stringify(exported.session)], { cwd: f.root, env: childEnvironment, encoding: "utf8", timeout: 15000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout) as TodoHierarchyResult;
  assert.equal(receipt.ok, false); assert.equal(receipt.refusals[0].code, "orphan_row"); assert.equal(receipt.applied, 0);
});
