/** @file Product metadata read from the manifests that own it. */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { objectAt, readJsonObject, stringAt } from "./json.ts";

/** Source manifests supply publication and dependency metadata to packaging. */
export function productManifests(workspaceRoot: string) {
  return ["packages", "plugins"].flatMap((base) =>
    readdirSync(join(workspaceRoot, base), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          existsSync(join(workspaceRoot, base, entry.name, "package.json")),
      )
      .map((entry) => {
        const dir = `${base}/${entry.name}`;
        const manifest = readJsonObject(
          join(workspaceRoot, dir, "package.json"),
        );
        return {
          dir,
          name: stringAt(manifest, "name") ?? "",
          published: manifest.private !== true,
          dependencies: objectAt(manifest, "dependencies"),
          exports: objectAt(manifest, "exports"),
        };
      }),
  );
}
