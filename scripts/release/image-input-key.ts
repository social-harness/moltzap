#!/usr/bin/env node
/**
 * @file Committed inputs of the Registry and Router images.
 * Run `node scripts/release/image-input-key.ts` at the repository root to
 * print {service: key}. Reads HEAD, never uncommitted files or build output.
 * Manifests omit release metadata; other files retain Git mode and blob id.
 */
import { Data, Effect, Either } from "effect";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import ts from "typescript";
import { parse } from "yaml";
import { exportCondition } from "../architecture/boundary-contract.ts";
import {
  byteOrder,
  digestOf,
  sortedJson,
  UNHASHED_FIELDS,
} from "./content-hash.ts";
import {
  erasedImport,
  moduleGraph,
  type ModuleReader,
  runtimeCall,
} from "./module-graph.ts";

/** A failed read or an incomplete committed input graph. */
export class ImageInputError extends Data.TaggedError("ImageInputError")<{
  readonly message: string;
  readonly cause?: unknown;
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
  readonly resolve: (file: string) => string;
}

/** Each class is disjoint; locked packages are virtual inputs, not whole lockfiles. */
interface ImageInputs {
  readonly own: readonly string[];
  readonly modules: readonly string[];
  readonly image: readonly string[];
  readonly tooling: readonly string[];
  readonly scripts: readonly string[];
  readonly locked: readonly string[];
  readonly key: string;
}

/** Lists reached modules that consume release versions; image workflows can enforce a version-free runtime. */
export function runtimeVersionReads(
  repo: string,
): Effect.Effect<readonly string[], ImageInputError> {
  return imageInputs(repo).pipe(
    Effect.flatMap((images) =>
      Effect.try({
        try: () => {
          const tree = checkout(repo);
          return [
            ...new Set(
              Object.values(images).flatMap((image) => [
                ...image.own,
                ...image.modules,
              ]),
            ),
          ]
            .filter(
              (file) =>
                /\.[cm]?[jt]s$/u.test(file) && !/\.d\.[cm]?ts$/u.test(file),
            )
            .filter((file) => readsManifestVersion(tree.read(file)))
            .sort(byteOrder);
        },
        catch: inputError,
      }),
    ),
  );
}

/** Computes keys and their input inventory from HEAD for release callers. */
export function imageInputs(
  repo: string,
): Effect.Effect<Readonly<Record<string, ImageInputs>>, ImageInputError> {
  return Effect.try({
    try: () => {
      const tree = checkout(repo);
      const roots = workspaceRoots(tree);
      return Object.fromEntries(
        SERVICES.map((service) => [service, inputs(service, roots, tree)]),
      );
    },
    catch: inputError,
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
  const resolve = (file: string) =>
    treeTarget(
      file,
      files,
      (id) => cache.get(id) ?? git(repo, ["cat-file", "blob", id]),
      new Set(),
    );
  return {
    files,
    resolve,
    read: (file) => {
      const found = files.get(resolve(file));
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
    committedEntry(tree, file),
  );

  entries.push(
    ...scripts.map(([name, body]) => `package.json#scripts.${name}\0${body}\n`),
  );
  entries.push(
    ...locked.map(
      ([id, value]) => `pnpm-lock.yaml#${id}\0${sortedJson(value)}\n`,
    ),
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
    own.map((file) => ({
      name,
      relative: path.posix.relative(root, tree.resolve(file)),
    })),
    roots,
    {
      conditions: [
        "node",
        "module-sync",
        "import",
        exportCondition({ internalOnly: true, types: "", import: "" }) ??
          "default",
        "default",
      ],
      all: true,
    },
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
  const scripts = mapping(readJson(tree, "package.json").scripts);
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
        return path.posix.relative(root, tree.resolve(file));
      }
      const config = `${root}/tsconfig.json`;
      const options = tree.files.has(config)
        ? mapping(readJson(tree, config).compilerOptions)
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
      return found === undefined
        ? undefined
        : path.posix.relative(root, tree.resolve(path.posix.join(root, found)));
    },
  };
}

/** Only build commands are traversed; unrelated manifest scripts and documentation are not build inputs. */
function buildInputs(
  tree: Tree,
  roots: readonly string[],
  images: readonly string[],
): string[] {
  const fixed = [
    "package.json",
    ".npmrc",
    ".dockerignore",
    "nx.json",
    "tsconfig.base.json",
    ".node-version",
  ].filter((file) => tree.files.has(file));
  const files = new Set(["pnpm-workspace.yaml", ...fixed]);
  const pending = [
    ...fixed,
    ...under(tree, "scripts/build"),
    ...images.filter((file) => file.endsWith("Dockerfile")),
    ...roots
      .map((root) => `${root}/tsconfig.json`)
      .filter((file) => tree.files.has(file)),
    ...roots.flatMap((root) => buildCommandFiles(tree, root)),
    ...images
      .filter((file) => file.endsWith("Dockerfile"))
      .flatMap((file) => dockerInputs(tree, file)),
    ...lifecycleFiles(tree),
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
  const manifest = readJson(tree, `${root}/package.json`);
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
    const parent = json(text, file).extends;
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
  const pending = [{ id: root, importer: true }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { id, importer } = next;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
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
      message: `pnpm-lock.yaml has no ${importer ? "importer" : "snapshot"} ${id}`,
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
  if (mapping(mapping(entry).resolution).type === "directory") {
    throw new ImageInputError({
      message: `Directory dependency ${id} is not supported`,
    });
  }
  return { package: entry, snapshot: block };
}

function runtimeIds(
  block: Record<string, unknown>,
  id: string,
  importer: boolean,
): Array<{ readonly id: string; readonly importer: boolean }> {
  return ["dependencies", "optionalDependencies"].flatMap((section) =>
    Object.entries(mapping(block[section])).map(([name, entry]) =>
      lockedId(name, importer ? mapping(entry).version : entry, id),
    ),
  );
}

function lockedId(
  name: string,
  version: unknown,
  importer: string,
): { readonly id: string; readonly importer: boolean } {
  if (typeof version !== "string") {
    throw new ImageInputError({
      message: `pnpm-lock.yaml has no locked version for ${name}`,
    });
  }
  if (version.startsWith("file:")) {
    throw new ImageInputError({
      message: `Directory dependency ${name}: ${version} is not supported`,
    });
  }
  if (version.startsWith("link:")) {
    return {
      id: path.posix.normalize(path.posix.join(importer, version.slice(5))),
      importer: true,
    };
  }
  const target = version.replace(/^npm:/u, "");
  return {
    id:
      /^[^(@][^(@]*@/u.test(target) || target.startsWith("@")
        ? target
        : `${name}@${target}`,
    importer: false,
  };
}

function under(tree: Tree, root: string): string[] {
  return [...tree.files.keys()].filter((file) => file.startsWith(`${root}/`));
}

function committedEntry(tree: Tree, file: string): string {
  const entry = tree.files.get(file);
  if (entry === undefined) {
    throw new ImageInputError({ message: `Missing committed input ${file}` });
  }
  if (entry.mode === "120000") {
    return `${file}\0${entry.mode}\0${entry.blob}\0${committedEntry(tree, tree.resolve(file))}\n`;
  }
  const blob =
    path.posix.basename(file) === "package.json"
      ? createHash("sha256")
          .update(
            sortedJson(
              Object.fromEntries(
                Object.entries(readJson(tree, file)).filter(
                  ([key]) => !UNHASHED_FIELDS.has(key),
                ),
              ),
            ),
          )
          .digest("hex")
      : entry.blob;
  return `${file}\0${entry.mode}\0${blob}\n`;
}

function inputError(cause: unknown): ImageInputError {
  return cause instanceof ImageInputError
    ? cause
    : new ImageInputError({ message: String(cause), cause });
}

function workspaceRoots(tree: Tree): ReadonlyMap<string, string> {
  return new Map(
    [...tree.files.keys()]
      .filter((file) => /^packages\/[^/]+\/package\.json$/u.test(file))
      .map((file) => [
        String(readJson(tree, file).name),
        path.posix.dirname(file),
      ]),
  );
}

function treeTarget(
  file: string,
  files: ReadonlyMap<string, File>,
  blob: (id: string) => string,
  seen: ReadonlySet<string>,
): string {
  const entry = files.get(file);
  if (entry === undefined || seen.has(file)) {
    throw new ImageInputError({
      message: `Missing or cyclic symlink image input ${file}`,
    });
  }
  if (entry.mode !== "120000") {
    return file;
  }
  const link = blob(entry.blob);
  const target = path.posix.isAbsolute(link)
    ? link
    : path.posix.normalize(path.posix.join(path.posix.dirname(file), link));
  if (target.startsWith("../") || path.posix.isAbsolute(target)) {
    throw new ImageInputError({
      message: `Outside-tree symlink image input ${file}`,
    });
  }
  return treeTarget(target, files, blob, new Set([...seen, file]));
}

function lifecycleFiles(tree: Tree): string[] {
  const scripts = mapping(readJson(tree, "package.json").scripts);
  return ["preinstall", "install", "postinstall", "prepare"].flatMap((name) => {
    const body = scripts[name];
    return typeof body === "string" ? commandFiles(tree, ".", body) : [];
  });
}

function commandFiles(tree: Tree, cwd: string, body: string): string[] {
  const scripts = mapping(readJson(tree, "package.json").scripts);
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
  const tokens = text.match(/"[^"\n]*"|'[^'\n]*'|[^\s;&|]+/gu) ?? [];
  const names: string[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token !== "pnpm") {
      continue;
    }
    let next = scriptToken(tokens, index + 1);
    if (tokens[next] === "run") {
      next = scriptToken(tokens, next + 1);
    }
    const name = tokens[next];
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names;
}

function readJson(tree: Tree, file: string): Record<string, unknown> {
  return json(tree.read(file), file);
}

function json(text: string, file: string): Record<string, unknown> {
  return Either.match(
    Effect.runSync(
      Effect.either(
        Effect.try({
          try: () => mapping(JSON.parse(text)),
          catch: (cause) =>
            new ImageInputError({ message: `Invalid JSON in ${file}`, cause }),
        }),
      ),
    ),
    {
      onLeft: (error) => {
        throw error;
      },
      onRight: (value) => value,
    },
  );
}

function mapping(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

/** COPY and ADD read the build context; stage copies consume already keyed build outputs. */
function dockerInputs(tree: Tree, file: string): string[] {
  return dockerCommands(tree.read(file))
    .split("\n")
    .flatMap((line) => {
      const instruction = line.trim();
      const match = /^(COPY|ADD)\b/iu.exec(instruction);
      if (match === null) {
        return [];
      }
      const body = instruction.slice(match[0].length).trimStart();
      if (/(?:^|[ \t])--from(?:=|[ \t])/u.test(body)) {
        return [];
      }
      const argumentsText = dockerArguments(body);
      const tokens = argumentsText.startsWith("[")
        ? asStrings(JSON.parse(argumentsText))
        : (argumentsText.match(/"[^"]*"|'[^']*'|\S+/gu) ?? []);
      return tokens.slice(0, -1).flatMap((token) => {
        const source = token
          .replace(/^["']|["']$/gu, "")
          .replace(/^\.\//u, "")
          .replace(/\/$/u, "");
        const candidates = [...tree.files.keys()].filter(
          (candidate) =>
            source === "." ||
            candidate === source ||
            candidate.startsWith(`${source}/`),
        );
        if (candidates.length === 0) {
          throw new ImageInputError({
            message: `Unsupported or missing ${match[1]} source ${source} in ${file}`,
          });
        }
        return candidates.filter((candidate) => candidate !== "pnpm-lock.yaml");
      });
    });
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function dockerCommands(text: string): string {
  return text.replaceAll("\r\n", "\n").replace(/\\\n/gu, " ");
}

function readsManifestVersion(text: string): boolean {
  const source = ts.createSourceFile(
    "module.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const manifests = new Set<string>();
  let reads = false;
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      reads = manifestImport(node, manifests) || reads;
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      manifestExpression(node.initializer, manifests)
    ) {
      reads = manifestBinding(node.name, manifests) || reads;
    }
    reads = expressionVersionRead(node, manifests) || reads;
    ts.forEachChild(node, visit);
  }
  visit(source);
  return reads;
}

function manifestImport(
  node: ts.ImportDeclaration,
  manifests: Set<string>,
): boolean {
  if (
    erasedImport(node.importClause) ||
    !manifestSpecifier(node.moduleSpecifier)
  ) {
    return false;
  }
  const clause = node.importClause;
  if (clause?.name !== undefined) {
    manifests.add(clause.name.text);
  }
  const bindings = clause?.namedBindings;
  if (bindings === undefined) {
    return false;
  }
  if (ts.isNamespaceImport(bindings)) {
    manifests.add(bindings.name.text);
    return false;
  }
  return bindings.elements.some(
    (item) =>
      !item.isTypeOnly && (item.propertyName ?? item.name).text === "version",
  );
}

function manifestBinding(
  name: ts.BindingName,
  manifests: Set<string>,
): boolean {
  if (ts.isIdentifier(name)) {
    manifests.add(name.text);
    return false;
  }
  return (
    ts.isObjectBindingPattern(name) &&
    name.elements.some(
      (item) =>
        (item.propertyName ?? item.name)
          .getText()
          .replaceAll('"', "")
          .replaceAll("'", "") === "version",
    )
  );
}

function scriptToken(tokens: readonly string[], start: number): number {
  let next = start;
  while (tokens[next]?.startsWith("-")) {
    next += ["--filter", "-F", "-C", "--dir"].includes(tokens[next] ?? "")
      ? 2
      : 1;
  }
  return next;
}

function dockerArguments(body: string): string {
  let text = body;
  while (text.startsWith("--")) {
    const space = text.search(/\s/u);
    if (space < 0) {
      return "";
    }
    text = text.slice(space).trimStart();
  }
  return text;
}

function expressionVersionRead(
  node: ts.Node,
  manifests: ReadonlySet<string>,
): boolean {
  return manifestExport(node) || versionAccess(node, manifests);
}

function versionAccess(node: ts.Node, manifests: ReadonlySet<string>): boolean {
  if (ts.isPropertyAccessExpression(node)) {
    return (
      node.name.text === "version" &&
      manifestExpression(node.expression, manifests)
    );
  }
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteral(node.argumentExpression)
  ) {
    return (
      node.argumentExpression.text === "version" &&
      manifestExpression(node.expression, manifests)
    );
  }
  return false;
}

function manifestExpression(
  node: ts.Node,
  manifests: ReadonlySet<string>,
): boolean {
  if (ts.isIdentifier(node)) {
    return manifests.has(node.text);
  }
  if (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node)) {
    return manifestExpression(node.expression, manifests);
  }
  if (ts.isPropertyAccessExpression(node) && node.name.text === "default") {
    return manifestExpression(node.expression, manifests);
  }
  return ts.isCallExpression(node) && manifestCall(node);
}

function manifestCall(node: ts.CallExpression): boolean {
  return runtimeCall(node) && node.arguments.some(manifestSpecifier);
}

function manifestExport(node: ts.Node): boolean {
  if (
    !ts.isExportDeclaration(node) ||
    node.isTypeOnly ||
    node.moduleSpecifier === undefined
  ) {
    return false;
  }
  if (!manifestSpecifier(node.moduleSpecifier)) {
    return false;
  }
  const bindings = node.exportClause;
  if (bindings === undefined) {
    return true;
  }
  return (
    ts.isNamedExports(bindings) &&
    bindings.elements.some(
      (item) =>
        !item.isTypeOnly && (item.propertyName ?? item.name).text === "version",
    )
  );
}

function manifestSpecifier(node: ts.Node): boolean {
  return ts.isStringLiteral(node) && /(?:^|\/)package\.json$/u.test(node.text);
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
