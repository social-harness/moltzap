/** @file Product metadata read from the manifests that own it. */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { objectAt, readJsonObject, stringAt } from "./json.ts";

/** Source manifests supply publication and dependency metadata to packaging and docs. */
export function productManifests(workspaceRoot: string) {
  return readdirSync(join(workspaceRoot, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = entry.name;
      const manifest = readJsonObject(
        join(workspaceRoot, "packages", dir, "package.json"),
      );
      return {
        dir,
        name: stringAt(manifest, "name") ?? "",
        published: manifest.private !== true,
        dependencies: objectAt(manifest, "dependencies"),
        exports: objectAt(manifest, "exports"),
      };
    });
}
