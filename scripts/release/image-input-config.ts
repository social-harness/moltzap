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

/** A config's file selection, each path joined to the config that declares it. */
export interface SourceGlobs {
  readonly files: readonly string[];
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

/** Resolves `files`, `include` and `exclude` as TypeScript does, through `extends` and to its defaults. */
export function sourceGlobs(tree: Tree, file: string): SourceGlobs {
  const files = declaredGlobs(tree, file, "files");
  return {
    files: files ?? [],
    include:
      declaredGlobs(tree, file, "include") ??
      (files === undefined
        ? [path.posix.join(path.posix.dirname(file), "**/*")]
        : []),
    exclude: declaredGlobs(tree, file, "exclude") ?? [],
  };
}

/** Narrows JSON arrays without coercing configuration values. */
export function asStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** The nearest declaration of one selection list; a later `extends` entry overrides an earlier one. */
function declaredGlobs(
  tree: Tree,
  file: string,
  key: keyof SourceGlobs,
  seen: ReadonlySet<string> = EMPTY_SEEN,
): readonly string[] | undefined {
  if (seen.has(file)) {
    throw new ImageInputError({
      message: `Cyclic tsconfig extends in ${file}`,
    });
  }
  const config = configValue(tree, file);
  if (Array.isArray(config[key])) {
    return asStrings(config[key]).map((entry) =>
      path.posix.normalize(path.posix.join(path.posix.dirname(file), entry)),
    );
  }
  return configParents(tree, file)
    .map((parent) => declaredGlobs(tree, parent, key, new Set([...seen, file])))
    .filter((globs): globs is readonly string[] => globs !== undefined)
    .at(-1);
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
