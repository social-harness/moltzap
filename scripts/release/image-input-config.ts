/** @file Committed TypeScript config parsing and compiler path resolution. */
import path from "node:path";
import ts from "typescript";
import { ImageInputError, mapping, type Tree } from "./image-input-tree.ts";
const EMPTY_SEEN: ReadonlySet<string> = new Set();
/** Follows committed TypeScript inheritance and project references. */
export function configInputs(
  tree: Tree,
  file: string,
  seen: ReadonlySet<string> = EMPTY_SEEN,
): string[] {
  if (seen.has(file)) {
    return [];
  }
  const config = configValue(tree, file);
  const references = Array.isArray(config.references)
    ? config.references
        .map((item) => mapping(item).path)
        .filter((item): item is string => typeof item === "string")
    : [];
  const targets = [
    ...configParents(tree, file),
    ...configTargets(tree, file, references),
  ];
  return [
    ...targets,
    ...targets.flatMap((target) =>
      configInputs(tree, target, new Set([...seen, file])),
    ),
  ];
}

/** Compiler paths retain the directory of the config that declares them. */
/** Resolves compiler paths relative to their declaring configs. */
export function compilerLayout(
  tree: Tree,
  file: string,
  seen: ReadonlySet<string> = EMPTY_SEEN,
): Record<string, unknown> {
  if (seen.has(file)) {
    throw new ImageInputError({
      message: `Cyclic tsconfig extends in ${file}`,
    });
  }
  const inherited: Record<string, unknown> = {};
  for (const parent of configParents(tree, file)) {
    Object.assign(
      inherited,
      compilerLayout(tree, parent, new Set([...seen, file])),
    );
  }
  const options = mapping(configValue(tree, file).compilerOptions);
  for (const key of ["outDir", "rootDir"]) {
    if (typeof options[key] === "string") {
      options[key] = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), options[key]),
      );
    }
  }
  return { ...inherited, ...options };
}

/** Narrows JSON arrays without coercing configuration values. */
export function asStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function configParents(tree: Tree, file: string): string[] {
  const config = configValue(tree, file);
  return configTargets(
    tree,
    file,
    typeof config.extends === "string"
      ? [config.extends]
      : asStrings(config.extends),
  );
}

function configValue(tree: Tree, file: string): Record<string, unknown> {
  const parsed = ts.parseConfigFileTextToJson(file, tree.read(file));
  if (parsed.error !== undefined) {
    throw new ImageInputError({ message: `Invalid TypeScript config ${file}` });
  }
  return mapping(parsed.config);
}

function configTargets(
  tree: Tree,
  file: string,
  entries: readonly string[],
): string[] {
  return entries.map((entry) => {
    const base = path.posix.normalize(
      path.posix.join(path.posix.dirname(file), entry),
    );
    const found = [base, `${base}.json`, `${base}/tsconfig.json`].find(
      (candidate) => tree.files.has(candidate),
    );
    if (found === undefined) {
      throw new ImageInputError({
        message: `Unaccounted tsconfig extends/reference ${entry} in ${file}`,
      });
    }
    return found;
  });
}
