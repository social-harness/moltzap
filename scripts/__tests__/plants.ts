/** @file Reversible file and symlink mutations shared by standalone gate tests. */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
/** The stack unwinds entries and snapshots in reverse mutation order. */
const planted: Array<{
  readonly path: string;
  readonly original?: string;
  readonly directory?: true;
}> = [];

/** Prepend, replace the whole file, or replace a required substring; missing substring targets fail. */
export function plantBoundarySource(input: {
  readonly path: string;
  readonly prepend?: string;
  readonly replace?: string;
  readonly before?: string;
  readonly after?: string;
}): void {
  plantFile(input.path, (source) => {
    if (input.prepend !== undefined) {
      return input.prepend + source;
    }
    if (input.replace !== undefined) {
      return input.replace;
    }
    if (
      input.before === undefined ||
      input.after === undefined ||
      !source.includes(input.before)
    ) {
      throw new Error(`Mutation target missing in ${input.path}`);
    }
    return source.replace(input.before, input.after);
  });
}

/** Snapshots existing bytes or records a created file after its write succeeds. */
export function plantFile(
  relativePath: string,
  mutate: (source: string) => string,
): void {
  const path = resolve(workspaceRoot, relativePath);
  const original = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const source = mutate(original ?? "");
  ensureParent(path);
  writeFileSync(path, source);
  planted.push(original === undefined ? { path } : { path, original });
}

/** Refuses existing entries, including dangling links, and records only a successfully created link. */
export function plantSymlink(relativePath: string, target: string): void {
  const path = resolve(workspaceRoot, relativePath);
  if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) {
    throw new Error(`Plant path already exists: ${relativePath}`);
  }
  ensureParent(path);
  symlinkSync(target, path);
  planted.push({ path });
}

/** Created entries tolerate prior removal; existing files recover their exact original bytes. */
export function restoreAllPlants(): void {
  for (const entry of planted.splice(0).reverse()) {
    if (entry.original === undefined) {
      rmSync(entry.path, {
        force: true,
        ...(entry.directory === true ? { recursive: true } : {}),
      });
    } else {
      writeFileSync(entry.path, entry.original);
    }
  }
}

/** Missing parent directories belong to the plant and are removed after its file. */
function ensureParent(path: string): void {
  const parent = dirname(path);
  if (!existsSync(parent)) {
    ensureParent(parent);
    mkdirSync(parent);
    planted.push({ path: parent, directory: true });
  }
}
