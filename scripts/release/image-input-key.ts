#!/usr/bin/env node
/**
 * @file Committed inputs of the Registry and Router images.
 * Run `node scripts/release/image-input-key.ts` at the repository root to
 * print {service: key}. Reads HEAD, never uncommitted files or build output.
 * Manifests omit release metadata; other files retain Git mode and blob id.
 */
import { Data, Effect } from "effect";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { parse } from "yaml";
import { digestOf } from "./content-hash.ts";
import { moduleGraph, type ModuleReader } from "./host-code-hash.ts";

/** A failed read or an incomplete committed input graph. */
export class ImageInputError extends Data.TaggedError("ImageInputError")<{
  readonly message: string;
}> {}

/** Image names are the only package layout choices the command fixes. */
export const SERVICES = ["registry", "router"] as const;

/** Git identity of one committed input. */
interface File {
  readonly mode: string;
  readonly blob: string;
}

/** A snapshot keeps traversal and hashing on the same committed revision. */
interface Tree {
  readonly files: ReadonlyMap<string, File>;
  readonly read: (file: string) => string;
}

/** Each class is disjoint; locked packages are virtual inputs, not whole lockfiles. */
export interface ImageInputs {
  readonly own: readonly string[];
  readonly modules: readonly string[];
  readonly image: readonly string[];
  readonly tooling: readonly string[];
  readonly scripts: readonly string[];
  readonly locked: readonly string[];
  readonly key: string;
}

/** Computes keys and their input inventory from HEAD for release callers. */
export function imageInputs(
  repo: string,
): Effect.Effect<Readonly<Record<string, ImageInputs>>, ImageInputError> {
  return Effect.try({
    try: () => {
      const tree = checkout(repo);
      const roots = new Map<string, string>();
      for (const file of tree.files.keys()) {
        if (/^packages\/[^/]+\/package\.json$/u.test(file)) {
          roots.set(
            String(json(tree.read(file)).name),
            path.posix.dirname(file),
          );
        }
      }
      return Object.fromEntries(
        SERVICES.map((service) => [service, inputs(service, roots, tree)]),
      );
    },
    catch: (cause) => new ImageInputError({ message: String(cause) }),
  });
}

function checkout(repo: string): Tree {
  const files = new Map<string, File>();
  for (const entry of git(repo, ["ls-tree", "-rz", "HEAD"])
    .split("\0")
    .filter(Boolean)) {
    const [header = "", file = ""] = entry.split("\t");
    const [mode = "", kind, blob = ""] = header.split(" ");
    if (kind === "blob") {
      files.set(file, { mode, blob });
    }
  }
  const cache = new Map<string, string>();
  return {
    files,
    read: (file) => {
      const found = files.get(file);
      if (found === undefined) {
        throw new ImageInputError({
          message: `Missing committed input ${file}`,
        });
      }
      const text =
        cache.get(found.blob) ?? git(repo, ["cat-file", "blob", found.blob]);
      cache.set(found.blob, text);
      return text;
    },
  };
}

function git(repo: string, args: readonly string[]): string {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- Git is the release runner's installed Git.
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new ImageInputError({
      message: result.stderr || String(result.error),
    });
  }
  return result.stdout;
}

function inputs(
  service: string,
  roots: ReadonlyMap<string, string>,
  tree: Tree,
): ImageInputs {
  const root = `packages/${service}`;
  const name = [...roots].find(([, directory]) => directory === root)?.[0];
  if (name === undefined) {
    throw new ImageInputError({ message: `Missing service ${service}` });
  }
  const own = under(tree, root);
  const { modules, reached } = siblingInputs(name, own, roots, tree);
  const directories = [...reached].map((sibling) => roots.get(sibling) ?? "");
  const image = under(tree, `images/${service}`);
  const tooling = buildInputs(tree, directories, image).filter(
    (file) =>
      !own.includes(file) && !modules.includes(file) && !image.includes(file),
  );
  const scripts = invokedScripts(
    tree,
    [...image, ...tooling],
    directories.flatMap((directory) => buildCommands(tree, directory).commands),
  );
  const locked = lockedClosure(tree.read("pnpm-lock.yaml"), root);
  const entries = [...own, ...modules, ...image, ...tooling].map((file) =>
    fileEntry(tree, file),
  );
  entries.push(
    `package.json#packageManager\0${stable(json(tree.read("package.json")).packageManager)}`,
  );
  entries.push(
    ...scripts.map(([name, body]) => `package.json#scripts.${name}\0${body}`),
  );
  entries.push(
    ...locked.map(([id, value]) => `pnpm-lock.yaml#${id}\0${stable(value)}`),
  );
  return {
    own,
    modules,
    image,
    tooling,
    scripts: scripts.map(([name]) => name),
    locked: locked.map(([id]) => id),
    key: digestOf(entries),
  };
}

/** Own files seed traversal; sibling manifests bind the exports used to reach their modules. */
function siblingInputs(
  name: string,
  own: readonly string[],
  roots: ReadonlyMap<string, string>,
  tree: Tree,
) {
  const root = roots.get(name) ?? "";
  const reader = sourceReader(tree);
  const graph = moduleGraph(
    own.map((file) => ({ name, relative: path.posix.relative(root, file) })),
    roots,
    reader,
  );
  const reached = new Set(graph.map((module) => module.name));
  const modules = [
    ...new Set(
      graph
        .filter((module) => module.name !== name)
        .map((module) =>
          path.posix.join(roots.get(module.name) ?? "", module.relative),
        ),
    ),
  ];
  for (const sibling of reached) {
    if (sibling !== name) {
      modules.push(`${roots.get(sibling)}/package.json`);
    }
  }
  return { modules, reached };
}

/** Root script bodies matter even when an edit changes only flags on the same executable. */
function invokedScripts(
  tree: Tree,
  files: readonly string[],
  commands: readonly string[],
): Array<readonly [string, string]> {
  const scripts = mapping(json(tree.read("package.json")).scripts);
  const found = new Map<string, string>();
  const pending = files
    .filter((file) => !file.endsWith(".json"))
    .map((file) =>
      file.endsWith("Dockerfile")
        ? dockerCommands(tree.read(file))
        : tree.read(file),
    );
  pending.push(...commands);
  for (let body = pending.pop(); body !== undefined; body = pending.pop()) {
    for (const name of scriptNames(body)) {
      const command = scripts[name];
      if (typeof command === "string" && !found.has(name)) {
        found.set(name, command);
        pending.push(command);
      }
    }
  }
  return [...found];
}

/** Maps emitted export targets and relative JS imports back through each package's compiler layout. */
function sourceReader(tree: Tree): ModuleReader {
  return {
    read: tree.read,
    missing: (specifier) => {
      throw new ImageInputError({
        message: `Missing workspace export target ${specifier}`,
      });
    },
    locate: (root, relative) => {
      const file = path.posix.join(root, relative);
      if (tree.files.has(file)) {
        return path.posix.relative(root, file);
      }
      const config = `${root}/tsconfig.json`;
      const options = tree.files.has(config)
        ? mapping(json(tree.read(config)).compilerOptions)
        : {};
      const outDir =
        typeof options.outDir === "string" ? options.outDir : "dist";
      const rootDir =
        typeof options.rootDir === "string" ? options.rootDir : "src";
      const emitted = relative.replace(/^\.\//u, "");
      const source = emitted.startsWith(`${outDir}/`)
        ? `${rootDir}/${emitted.slice(outDir.length + 1)}`
        : emitted;
      const candidates = [
        source.replace(/\.js$/u, ".ts"),
        source.replace(/\.mjs$/u, ".mts"),
        source.replace(/\.cjs$/u, ".cts"),
        `${source}.ts`,
        `${source}/index.ts`,
      ];
      const found = candidates.find((candidate) =>
        tree.files.has(path.posix.join(root, candidate)),
      );
      return found;
    },
  };
}

/** Only build commands are traversed; unrelated manifest scripts and documentation are not build inputs. */
function buildInputs(
  tree: Tree,
  roots: readonly string[],
  images: readonly string[],
): string[] {
  const fixed = ["nx.json", "tsconfig.base.json", ".node-version"].filter(
    (file) => tree.files.has(file),
  );
  const files = new Set(["pnpm-workspace.yaml", ...fixed]);
  const pending = [
    ...under(tree, "scripts/build"),
    ...images.filter((file) => file.endsWith("Dockerfile")),
    ...roots
      .map((root) => `${root}/tsconfig.json`)
      .filter((file) => tree.files.has(file)),
    ...roots.flatMap((root) => buildCommandFiles(tree, root)),
  ];
  const seen = new Set<string>();
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    files.add(file);
    pending.push(...namedInputs(tree, file));
  }
  return [...files];
}

function buildCommandFiles(tree: Tree, root: string): string[] {
  const { cwd, commands } = buildCommands(tree, root);
  return commands.flatMap((command) => commandFiles(tree, cwd, command));
}

function buildCommands(tree: Tree, root: string) {
  const manifest = json(tree.read(`${root}/package.json`));
  const target = mapping(mapping(mapping(manifest.nx).targets).build);
  const options = mapping(target.options);
  const commands = [
    mapping(manifest.scripts).build,
    options.command,
    ...asStrings(options.commands),
  ].filter((command): command is string => typeof command === "string");
  const cwd = typeof options.cwd === "string" ? options.cwd : root;
  return { cwd, commands };
}

/** Config inheritance and command paths are separate from source files mentioned by include globs. */
function namedInputs(tree: Tree, file: string): string[] {
  const text = tree.read(file);
  if (file.endsWith(".json")) {
    const parent = json(text).extends;
    const parents = typeof parent === "string" ? [parent] : asStrings(parent);
    return parents
      .map((entry) =>
        path.posix.normalize(path.posix.join(path.posix.dirname(file), entry)),
      )
      .filter((entry) => tree.files.has(entry));
  }
  const body = file.endsWith("Dockerfile") ? dockerCommands(text) : text;
  return commandFiles(tree, path.posix.dirname(file), body);
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function dockerCommands(text: string): string {
  return text
    .replace(/\\\n/gu, " ")
    .split("\n")
    .filter((line) => /^\s*RUN\s/iu.test(line))
    .join("\n");
}

function commandFiles(tree: Tree, cwd: string, body: string): string[] {
  const scripts = mapping(json(tree.read("package.json")).scripts);
  return [body, ...scriptBodies(body, scripts)]
    .flatMap((text) => text.split(/[\s"'`=,;()[\]{}&|]+/u))
    .flatMap((token) => [
      token.replace(/^\.\//u, ""),
      path.posix.normalize(path.posix.join(cwd, token)),
    ])
    .filter(
      (target) =>
        tree.files.has(target) &&
        !["pnpm-lock.yaml", "package.json"].includes(target),
    );
}

function scriptBodies(
  text: string,
  scripts: Record<string, unknown>,
): string[] {
  const found = new Set<string>();
  const pending = scriptNames(text);
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    const body = scripts[name];
    if (typeof body === "string" && !found.has(body)) {
      found.add(body);
      pending.push(...scriptNames(body));
    }
  }
  return [...found];
}

function scriptNames(text: string): string[] {
  return [...text.matchAll(/\bpnpm\s+(?:run\s+)?([\w:-]+)/gu)].map(
    (match) => match[1] ?? "",
  );
}

/** Runtime edges include optional dependencies and workspace links, but exclude dev-only packages. */
function lockedClosure(
  text: string,
  root: string,
): ReadonlyArray<readonly [string, unknown]> {
  const lock: unknown = parse(text);
  const value = mapping(lock);
  if (String(value.lockfileVersion) !== "9.0") {
    throw new ImageInputError({
      message: "Unsupported pnpm-lock.yaml version; expected 9.0",
    });
  }
  const found = new Map<string, unknown>();
  const seen = new Set<string>();
  const pending = [root];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const importer = Object.hasOwn(mapping(value.importers), id);
    const block = lockedBlock(value, id, importer);
    if (!importer) {
      found.set(id, pinnedPackage(value, id, block));
    }
    pending.push(...runtimeIds(block, id, importer));
  }
  return [...found].sort(([a], [b]) => (a < b ? -1 : Number(a !== b)));
}

function lockedBlock(
  lock: Record<string, unknown>,
  id: string,
  importer: boolean,
): Record<string, unknown> {
  const section = importer ? "importers" : "snapshots";
  const block = mapping(lock[section])[id];
  if (block === undefined) {
    throw new ImageInputError({
      message: `pnpm-lock.yaml has no ${id.startsWith("packages/") ? "importer" : "snapshot"} ${id}`,
    });
  }
  return mapping(block);
}

function pinnedPackage(
  lock: Record<string, unknown>,
  id: string,
  block: unknown,
): unknown {
  const base = id.split("(")[0] ?? id;
  const entry = mapping(lock.packages)[base];
  if (entry === undefined) {
    throw new ImageInputError({
      message: `pnpm-lock.yaml has no package ${base}`,
    });
  }
  return { package: entry, snapshot: block };
}

function runtimeIds(
  block: Record<string, unknown>,
  id: string,
  importer: boolean,
): string[] {
  return ["dependencies", "optionalDependencies"].flatMap((section) =>
    Object.entries(mapping(block[section])).map(([name, entry]) =>
      lockedId(name, importer ? mapping(entry).version : entry, id),
    ),
  );
}

function lockedId(name: string, version: unknown, importer: string): string {
  if (typeof version !== "string") {
    throw new ImageInputError({
      message: `pnpm-lock.yaml has no locked version for ${name}`,
    });
  }
  if (version.startsWith("link:")) {
    return path.posix.normalize(path.posix.join(importer, version.slice(5)));
  }
  const target = version.replace(/^npm:/u, "");
  return /^[^(@][^(]*@/u.test(target) || target.startsWith("@")
    ? target
    : `${name}@${target}`;
}

function under(tree: Tree, root: string): string[] {
  return [...tree.files.keys()].filter((file) => file.startsWith(`${root}/`));
}

function fileEntry(tree: Tree, file: string): string {
  const entry = tree.files.get(file);
  if (entry === undefined) {
    throw new ImageInputError({ message: `Missing committed input ${file}` });
  }
  const blob =
    path.posix.basename(file) === "package.json"
      ? createHash("sha256")
          .update(
            stable(
              Object.fromEntries(
                Object.entries(json(tree.read(file))).filter(
                  ([key]) =>
                    ![
                      "version",
                      "sharnessContentHash",
                      "sharnessHostCodeHash",
                    ].includes(key),
                ),
              ),
            ),
          )
          .digest("hex")
      : entry.blob;
  return `${file}\0${entry.mode}\0${blob}`;
}

function json(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  return mapping(value);
}

function mapping(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : Number(a !== b)))
      .map(([key, item]) => [JSON.stringify(key), stable(item)].join(":"))
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

if (import.meta.main) {
  Effect.runSync(
    imageInputs(process.cwd()).pipe(
      Effect.match({
        onFailure: (error) => {
          process.stderr.write(`${error.message}\n`);
          process.exitCode = 1;
        },
        onSuccess: (result) => {
          process.stdout.write(
            `${JSON.stringify(Object.fromEntries(Object.entries(result).map(([service, input]) => [service, input.key])))}\n`,
          );
        },
      }),
    ),
  );
}
