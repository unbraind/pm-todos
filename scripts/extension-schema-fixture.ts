/** Real local extension fixture shared by installed-consumer and native SDK tests. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as Core from "@unbrained/pm-cli/sdk";

/** Install a schema-only extension with its own folder and opaque native fields. */
export async function installSchemaFixture(core: Pick<typeof Core, "packageInstall">, root: string, pmRoot: string, suffix = "one") {
  const name = "fixture-schema-" + suffix, directory = join(root, name);
  const type = "FixtureBridge" + suffix, note = "fixture_note_" + suffix, payload = "fixture_payload_" + suffix;
  mkdirSync(directory);
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name, version: "1.0.0", type: "module", main: "index.js" }));
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({ name, version: "1.0.0", entry: "index.js", pm_min_version: "2026.10.23", capabilities: ["schema"] }));
  writeFileSync(join(directory, "index.js"), `export default {activate(api) {
    api.registerItemTypes([{name:${JSON.stringify(type)},folder:${JSON.stringify("fixture-bridges-" + suffix)}}]);
    api.registerItemFields([{name:${JSON.stringify(note)},type:"string",optional:true},{name:${JSON.stringify(payload)},type:"object",optional:true}]);
  }};`);
  await core.packageInstall(directory, { project: true }, { pmRoot });
  return { type, note, payload };
}
/** Read full native documents using only the SDK's currently registered schema and folder map. */
export async function readSchemaDocuments(core: Pick<typeof Core, "runWithActiveExtensions" | "readSettings" | "getActiveExtensionRegistrations" | "resolveItemTypeRegistry" | "locateItem" | "readLocatedItem">, pmRoot: string, ids: string[]) {
  return core.runWithActiveExtensions({ path: pmRoot }, async () => {
    const settings = await core.readSettings(pmRoot), registrations = core.getActiveExtensionRegistrations();
    const fields = registrations?.item_fields.flatMap(entry => entry.fields.map(field => field.name)) ?? [];
    const folders = core.resolveItemTypeRegistry(settings, registrations).type_to_folder;
    return Promise.all(ids.map(async id => {
      const located = await core.locateItem(pmRoot, id, settings.id_prefix, settings.item_format, folders);
      if (!located) throw new Error("Missing fixture identity");
      return (await core.readLocatedItem(located, { schema: settings.schema, extensionFieldNames: fields })).document;
    }));
  });
}
