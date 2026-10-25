#!/usr/bin/env node
/**
 * @file Committed inputs of the Registry and Router images.
 * Run `node scripts/release/image-input-key.ts` at the repository root to
 * print {service: key}. Reads HEAD, never uncommitted files or build output.
 * Manifests omit release metadata; other files retain Git mode and blob id.
 */
import { Effect } from "effect";
import { createHash } from "node:crypto";
import path from "node:path";
import { parse } from "yaml";
import { INTERNAL_EXPORT_CONDITION } from "../architecture/boundary-contract.ts";
import {
  byteOrder,
  digestOf,
  sortedJson,
  UNHASHED_FIELDS,
} from "./content-hash.ts";
import { dockerContextInputs } from "./image-dockerfile.ts";
import {
  asStrings,
  compilerLayout,
  configInputs,
} from "./image-input-config.ts";
import {
  checkout,
  ImageInputError,
  inputError,
  mapping,
  readJson,
  type Tree,
  under,
  workspaceRoots,
} from "./image-input-tree.ts";
import { readsManifestVersion } from "./image-runtime-version.ts";
import {
  moduleGraph,
  type ModuleReader,
  runtimeModule,
} from "./module-graph.ts";
/** Typed refusal shared by image key callers. */
export { ImageInputError } from "./image-input-tree.ts";

/** Image keys omit wire metadata because releases record it without changing committed runtime inputs.
 * Packed content and host hashes retain it under their existing manifest contract.
 */
const IMAGE_UNHASHED_FIELDS: ReadonlySet<string> = new Set([
  ...UNHASHED_FIELDS,
  "sharnessWireVersion",
]);

/** Image names are the only package layout choices the command fixes. */
export const SERVICES = ["registry", "router"] as const;

const IMAGE_CONDITIONS = [
  "node",
  "module-sync",
  "require",
  "import",
  INTERNAL_EXPORT_CONDITION,
  "default",
];

/** Runtime modules are a subset of own and sibling inputs; locked packages are virtual inputs. */
interface ImageInputs {
  readonly own: readonly string[];
  readonly modules: readonly string[];
  readonly image: readonly string[];
  readonly tooling: readonly string[];
  readonly locked: readonly string[];
  readonly runtime: readonly string[];
  readonly key: string;
}

interface ShellState {
  quote: string;
  comment: boolean;
  escaped: boolean;
}

/**
 * Lists reached modules in each service's own package that consume manifest versions.
 * Sibling Client version strings belong to daemon reporting, outside this gate.
 */
export function runtimeVersionReads(
  repo: string,
): Effect.Effect<readonly string[], ImageInputError> {
  return Effect.try({
    try: () => {
      const tree = checkout(repo);
      return [
        ...new Set(
          Object.entries(imagesFromTree(tree)).flatMap(([service, image]) =>
            image.runtime.filter((file) =>
              file.startsWith(`packages/${service}/`),
            ),
          ),
        ),
      ]
        .filter((file) => isRuntimeInput(tree, file))
        .filter((file) => readsManifestVersion(tree.read(file)))
        .sort(byteOrder);
    },
    catch: inputError,
  });
}

/** Computes keys and their input inventory from HEAD for release callers. */
export function imageInputs(
  repo: string,
): Effect.Effect<Readonly<Record<string, ImageInputs>>, ImageInputError> {
  return Effect.try({
    try: () => {
      const tree = checkout(repo);
      return imagesFromTree(tree);
    },
    catch: inputError,
  });
}

function imagesFromTree(tree: Tree): Readonly<Record<string, ImageInputs>> {
  const roots = workspaceRoots(tree);
  return Object.fromEntries(
    SERVICES.map((service) => [service, inputs(service, roots, tree)]),
  );
}

/** Manifest binaries can be extensionless, while declarations remain erased. */
function isRuntimeInput(tree: Tree, file: string): boolean {
  const root = [...workspaceRoots(tree).values()].find((directory) =>
    file.startsWith(`${directory}/`),
  );
  const manifest =
    root === undefined
      ? {}
      : readJson(tree, path.posix.join(root, "package.json"));
  return runtimeModule(
    file,
    tree.read(file),
    binTargets(manifest.bin).some(
      (target) => path.posix.join(root ?? "", target) === file,
    ),
  );
}

function binTargets(bin: unknown): string[] {
  return typeof bin === "string"
    ? [bin]
    : Object.values(mapping(bin)).filter(
        (target): target is string => typeof target === "string",
      );
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
  const { modules, reached, runtime } = siblingInputs(name, own, roots, tree);
  const image = serviceImages(tree, service, name);
  const directories = [...reached].map((sibling) => roots.get(sibling) ?? "");
  const locked = lockedClosure(tree.read("pnpm-lock.yaml"), root, {
    roots,
    tree,
    directories,
  });
  const installed = locked
    .filter(([id]) => id.startsWith("importer:"))
    .map(([id]) => id.slice("importer:".length));
  const tooling = buildInputs(
    { ...tree, service: name },
    [...new Set([...directories, ...installed])],
    image,
  ).filter((file) => ![...own, ...modules, ...image].includes(file));
  const entries = [...own, ...modules, ...image, ...tooling].map((file) =>
    committedEntry(tree, file),
  );

  entries.push(
    ...locked.map(
      ([id, value]) => `pnpm-lock.yaml#${id}\0${sortedJson(value)}\n`,
    ),
  );
  return {
    own,
    runtime,
    modules,
    image,
    tooling,
    locked: locked.map(([id]) => id),
    key: digestOf(entries),
  };
}

function serviceImages(tree: Tree, service: string, name: string): string[] {
  const files = under(tree, `images/${service}`);
  for (const file of files.filter(isBuildFile)) {
    dockerContextInputs(tree, file, name);
  }
  return files;
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
    own
      .filter(
        (file) =>
          tree.files.get(file)?.mode !== "120000" ||
          /\.[cm]?[jt]s$/u.test(file),
      )
      .map((file) => ({
        name,
        relative: path.posix.relative(root, tree.resolve(file)),
      })),
    roots,
    {
      conditions: IMAGE_CONDITIONS,
      all: true,
    },
    reader,
  );
  const reached = new Set(graph.map((module) => module.name));
  const modules = [
    ...new Set(
      graph
        .map((module) =>
          path.posix.join(roots.get(module.name) ?? "", module.relative),
        )
        .filter((file) => !own.includes(file)),
    ),
  ];
  for (const sibling of reached) {
    if (sibling !== name) {
      modules.push(`${roots.get(sibling)}/package.json`);
    }
  }
  const runtime = runtimeInputs(name, own, roots, tree);
  return { modules, reached, runtime };
}

function runtimeInputs(
  name: string,
  own: readonly string[],
  roots: ReadonlyMap<string, string>,
  tree: Tree,
): string[] {
  const root = roots.get(name) ?? "";
  const reader = sourceReader(tree);
  const inactive = new Set(
    testEntryTargets(
      readJson(tree, path.posix.join(root, "package.json")).exports,
    )
      .filter(
        (target) =>
          !activeEntryTargets(
            readJson(tree, path.posix.join(root, "package.json")).exports,
          ).includes(target),
      )
      .flatMap((target) => reader.locate(root, target) ?? [])
      .map((target) => path.posix.join(root, target)),
  );
  return moduleGraph(
    own
      .filter(
        (file) =>
          !testInput(file) &&
          !inactive.has(file) &&
          (tree.files.get(file)?.mode !== "120000" ||
            /\.[cm]?[jt]s$/u.test(file)),
      )
      .map((file) => ({
        name,
        relative: path.posix.relative(root, tree.resolve(file)),
      })),
    roots,
    {
      conditions: IMAGE_CONDITIONS,
      all: true,
    },
    reader,
  ).map((module) =>
    path.posix.join(roots.get(module.name) ?? "", module.relative),
  );
}

function testEntryTargets(value: unknown, testOnly = false): string[] {
  if (typeof value === "string") {
    return testOnly ? [value] : [];
  }
  return Object.entries(mapping(value)).flatMap(([condition, target]) =>
    testEntryTargets(target, testOnly || condition === "sharness-test"),
  );
}

function activeEntryTargets(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  return Object.entries(mapping(value))
    .filter(([condition]) => !["types", "sharness-test"].includes(condition))
    .flatMap(([, target]) => activeEntryTargets(target));
}

function testInput(file: string): boolean {
  return /(?:(?:^|\/)(?:test|tests|__tests__)[/.]|\.(?:test|spec|types-check)\.[cm]?[jt]s$)/u.test(
    file,
  );
}

/** Build commands discover executables; the whole root manifest binds installation and script configuration. */
function buildInputs(
  tree: Tree,
  roots: readonly string[],
  images: readonly string[],
): string[] {
  const buildTree: Tree = { ...tree, commandCwds: new Map() };
  const fixed = [
    "package.json",
    ".npmrc",
    ".dockerignore",
    "nx.json",
    "tsconfig.base.json",
    ".node-version",
    ".pnpmfile.cjs",
  ].filter((file) => buildTree.files.has(file));
  const files = new Set([
    "pnpm-workspace.yaml",
    ...fixed,
    ...images
      .filter(isBuildFile)
      .flatMap((file) =>
        dockerContextInputs(buildTree, file, tree.service ?? "").filter(
          (input) => includedCopy(buildTree, input, roots),
        ),
      ),
  ]);
  const pending = [
    ...fixed,
    ...images.filter(isBuildFile),
    ...roots.map((root) => path.posix.join(root, "package.json")),
    ...roots
      .map((root) => `${root}/tsconfig.json`)
      .filter((file) => buildTree.files.has(file)),
    ...roots.flatMap((root) => buildCommandFiles(buildTree, root)),
    ...[".", ...roots].flatMap((root) => lifecycleFiles(buildTree, root)),
  ];
  const seen = new Set<string>();
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    const traversal = `${file}#${JSON.stringify([...(buildTree.commandCwds?.get(file) ?? [])].sort(byteOrder))}`;
    if (seen.has(traversal)) {
      continue;
    }
    seen.add(traversal);
    files.add(file);
    pending.push(...namedInputs(buildTree, file));
  }
  return [...files];
}

/**
 * Copied siblings bind only packed non-source content; executable inputs are discovered separately.
 * A copied sibling must declare `files`: without it pnpm packs whatever its ignore files allow.
 */
function includedCopy(
  tree: Tree,
  file: string,
  roots: readonly string[],
): boolean {
  const own = workspaceRoots(tree).get(tree.service ?? "");
  const sibling = roots.find(
    (root) => root !== "." && root !== own && file.startsWith(`${root}/`),
  );
  if (sibling === undefined) {
    return true;
  }
  const relative = path.posix.relative(sibling, file);
  if (/^(?:src|bin)\//u.test(relative)) {
    return false;
  }
  const declared = readJson(tree, `${sibling}/package.json`).files;
  if (!Array.isArray(declared)) {
    throw new ImageInputError({
      message: `Copied workspace package ${sibling}/package.json declares no files list; an image binds a copied sibling by what it packs`,
    });
  }
  const patterns = asStrings(declared);
  return (
    /^(?:package\.json|readme(?:\..*)?|licen[cs]e(?:\..*)?|notice(?:\..*)?)$/iu.test(
      relative,
    ) ||
    (patterns.some(
      (pattern) => !pattern.startsWith("!") && packedPath(relative, pattern),
    ) &&
      !patterns.some(
        (pattern) =>
          pattern.startsWith("!") && packedPath(relative, pattern.slice(1)),
      ))
  );
}

function packedPath(file: string, pattern: string): boolean {
  const normalized = pattern.replace(/^\.\//u, "").replace(/\/$/u, "");
  return (
    path.posix.matchesGlob(file, normalized) ||
    path.posix.matchesGlob(file, `${normalized}/**`)
  );
}

function buildCommandFiles(tree: Tree, root: string): string[] {
  const manifest = readJson(tree, path.posix.join(root, "package.json"));
  const projectFile = path.posix.join(root, "project.json");
  const targetFile = tree.files.has(projectFile)
    ? projectFile
    : path.posix.join(root, "package.json");
  const project = tree.files.has(projectFile)
    ? readJson(tree, projectFile)
    : mapping(manifest.nx);
  const target = mapping(mapping(project.targets).build);
  if (unsupportedBuild(target)) {
    throw new ImageInputError({
      message: `Unsupported Nx build layout in ${targetFile}`,
    });
  }
  const options = mapping(target.options);
  const commands = [options.command, ...arrayValues(options.commands)]
    .map((value) =>
      typeof value === "string" ? value : mapping(value).command,
    )
    .filter((value): value is string => typeof value === "string");
  const script = mapping(manifest.scripts).build;
  return [
    ...(tree.files.has(projectFile) ? [projectFile] : []),
    ...(typeof script === "string" ? commandFiles(tree, root, script) : []),
    ...commands.flatMap((command) =>
      commandFiles(
        tree,
        typeof options.cwd === "string" ? options.cwd : root,
        command,
      ),
    ),
  ];
}

function unsupportedBuild(target: Record<string, unknown>): boolean {
  return (
    target.configurations !== undefined ||
    (target.executor !== undefined && target.executor !== "nx:run-commands")
  );
}

function arrayValues(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Only executable text names build files; copied content never becomes a command. */
function namedInputs(tree: Tree, file: string): string[] {
  const text = tree.read(file);
  if (/tsconfig[^/]*\.json$/u.test(file)) {
    return configInputs(tree, file);
  }
  if (/\.[cm]?[jt]s$/u.test(file)) {
    const roots = new Map([...workspaceRoots(tree), ["@image-build", "."]]);
    return moduleGraph(
      [{ name: "@image-build", relative: tree.resolve(file) }],
      roots,
      {
        conditions: IMAGE_CONDITIONS,
        all: true,
      },
      sourceReader(tree),
    ).map((module) =>
      path.posix.join(roots.get(module.name) ?? "", module.relative),
    );
  }
  return file.endsWith(".sh") || text.startsWith("#!")
    ? [...(tree.commandCwds?.get(file) ?? ["."])].flatMap((cwd) =>
        commandFiles(tree, cwd, text, file),
      )
    : [];
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
        ? compilerLayout(tree, config)
        : {};
      const outDir =
        typeof options.outDir === "string"
          ? path.posix.relative(root, options.outDir)
          : "dist";
      const rootDir =
        typeof options.rootDir === "string"
          ? path.posix.relative(root, options.rootDir)
          : "src";
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

function isBuildFile(file: string): boolean {
  const name = path.posix.basename(file);
  return (
    /^(?:Dockerfile|Containerfile)/u.test(name) || name.endsWith(".Dockerfile")
  );
}

/** Runtime edges include optional dependencies and workspace links, but exclude dev-only packages. */
function lockedClosure(
  text: string,
  root: string,
  context: {
    readonly roots: ReadonlyMap<string, string>;
    readonly tree: Tree;
    readonly directories: readonly string[];
  },
): ReadonlyArray<readonly [string, unknown]> {
  const { roots, tree, directories } = context;
  const lock: unknown = parse(text);
  const value = mapping(lock);
  if (String(value.lockfileVersion) !== "9.0") {
    throw new ImageInputError({
      message: "Unsupported pnpm-lock.yaml version; expected 9.0",
    });
  }
  const found = new Map<string, unknown>([
    ["settings", value.settings],
    ["pnpmfileChecksum", value.pnpmfileChecksum],
  ]);
  const seen = new Set<string>();
  const pending = [
    ...new Set([
      ...directories.filter((directory) => directory !== root),
      ...(mapping(value.importers)["."] === undefined ? [] : ["."]),
      root,
    ]),
  ].map((id) => ({
    id,
    importer: true,
  }));
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { id, importer } = next;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const block = lockedBlock(value, id, importer);
    accountImporter(importer, id, block, roots);
    if (!importer) {
      found.set(id, pinnedPackage(value, id, block));
    } else {
      pending.push(...importerInputs(id, block, tree, found));
    }
    pending.push(...runtimeIds(block, id, importer));
  }
  return [...found].sort(([a], [b]) => (a < b ? -1 : Number(a !== b)));
}

function importerInputs(
  id: string,
  block: Record<string, unknown>,
  tree: Tree,
  found: Map<string, unknown>,
) {
  const sections = Object.fromEntries(
    ["dependencies", "optionalDependencies"].map((section) => [
      section,
      Object.fromEntries(
        Object.entries(mapping(block[section])).map(([name, entry]) => [
          name,
          lockedId(name, mapping(entry).version, id),
        ]),
      ),
    ]),
  );
  found.set(`importer:${id}`, sections);
  return Object.keys(
    mapping(
      readJson(tree, path.posix.join(id, "package.json")).devDependencies,
    ),
  ).map((name) => {
    const resolved = lockedId(
      name,
      mapping(mapping(block.devDependencies)[name]).version,
      id,
    );
    found.set(`tool:${id}:${name}`, resolved);
    return resolved;
  });
}

/** Workspace links are accepted only when their import name and directory are both traversable. */
function accountImporter(
  importer: boolean,
  id: string,
  block: Record<string, unknown>,
  roots: ReadonlyMap<string, string>,
): void {
  if (!importer) {
    return;
  }
  if (id !== "." && ![...roots.values()].includes(id)) {
    throw new ImageInputError({
      message: `Unaccounted workspace importer ${id}/package.json in pnpm-lock.yaml`,
    });
  }
  const entries = ["dependencies", "optionalDependencies"].flatMap((section) =>
    Object.entries(mapping(block[section])),
  );
  for (const [name, entry] of entries) {
    const version = mapping(entry).version;
    if (typeof version === "string" && version.startsWith("link:")) {
      accountLink(name, version, id, roots);
    }
  }
}

function accountLink(
  name: string,
  version: string,
  id: string,
  roots: ReadonlyMap<string, string>,
): void {
  const target = path.posix.normalize(path.posix.join(id, version.slice(5)));
  if (roots.get(name) !== target) {
    throw new ImageInputError({
      message: `Unaccounted workspace link ${name} to ${target}/package.json in pnpm-lock.yaml`,
    });
  }
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

function committedEntry(tree: Tree, file: string): string {
  const entry = tree.files.get(file);
  if (entry === undefined) {
    throw new ImageInputError({ message: `Missing committed input ${file}` });
  }
  if (entry.mode === "160000") {
    throw new ImageInputError({ message: `Unsupported gitlink input ${file}` });
  }
  if (entry.mode === "120000") {
    return /\.[cm]?[jt]s$/u.test(file)
      ? `${file}\0${entry.mode}\0${entry.blob}\0${committedEntry(tree, tree.resolve(file))}\n`
      : `${file}\0${entry.mode}\0${entry.blob}\n`;
  }
  const blob =
    path.posix.basename(file) === "package.json"
      ? createHash("sha256")
          .update(
            sortedJson(
              Object.fromEntries(
                Object.entries(readJson(tree, file)).filter(
                  ([key]) => !IMAGE_UNHASHED_FIELDS.has(key),
                ),
              ),
            ),
          )
          .digest("hex")
      : entry.blob;
  return `${file}\0${entry.mode}\0${blob}\n`;
}

function lifecycleFiles(tree: Tree, root: string): string[] {
  const scripts = mapping(
    readJson(tree, path.posix.join(root, "package.json")).scripts,
  );
  return ["preinstall", "install", "postinstall", "prepare"].flatMap((name) => {
    const body = scripts[name];
    return typeof body === "string" ? commandFiles(tree, root, body) : [];
  });
}

function commandFiles(
  tree: Tree,
  cwd: string,
  body: string,
  file = "",
): string[] {
  const manifest = path.posix.join(cwd, "package.json");
  const sourceFile = file || manifest;
  const scripts = tree.files.has(manifest)
    ? mapping(readJson(tree, manifest).scripts)
    : {};
  const executable = shellText(body);
  const bodies = [executable, ...scriptBodies(executable, scripts)].map(
    shellText,
  );
  for (const text of bodies) {
    if (scopedScript(text)) {
      throw new ImageInputError({
        message: `Unsupported scoped pnpm run in ${sourceFile}`,
      });
    }
    if (tree.service !== undefined) {
      validateInstall(text, sourceFile, tree.service);
    }
  }
  const files = bodies
    .flatMap((text) => text.split(/[\s"'`=,;()[\]{}&|]+/u))
    .map((token) => path.posix.normalize(path.posix.join(cwd, token)))
    .filter(
      (target) =>
        tree.files.has(target) &&
        !["pnpm-lock.yaml", "package.json"].includes(target),
    );
  recordCommands(tree, cwd, files);
  return files;
}

function recordCommands(
  tree: Tree,
  cwd: string,
  files: readonly string[],
): void {
  for (const target of files) {
    const directories = tree.commandCwds?.get(target) ?? new Set<string>();
    directories.add(cwd);
    tree.commandCwds?.set(target, directories);
  }
}

function scopedScript(text: string): boolean {
  return text.split(/[;&|\n]+/u).some(scopedCommand);
}

function scopedCommand(text: string): boolean {
  const tokens: readonly string[] =
    text.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/gu) ?? [];
  const index = tokens.indexOf("pnpm");
  const scoped = tokens.some((token) =>
    /^(?:--filter(?:=|$)|-F$|-C$|--dir(?:=|$))/u.test(token),
  );
  return (
    index >= 0 &&
    scoped &&
    !["install", "deploy", "exec"].includes(
      tokens[scriptToken(tokens, index + 1)] ?? "",
    )
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
    if (typeof body === "string" && !found.has(shellText(body))) {
      found.add(shellText(body));
      pending.push(...scriptNames(shellText(body)));
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

/** Shell comments start outside quotes at a token boundary. */
function shellText(text: string): string {
  const state = { quote: "", comment: false, escaped: false };
  let result = "";
  for (let index = 0; index < text.length; index++) {
    result += shellCharacter(state, text.charAt(index), text.charAt(index - 1));
  }
  return result;
}

function shellCharacter(
  state: ShellState,
  character: string,
  previous: string,
): string {
  if (character === "\n") {
    state.comment = false;
  }
  if (state.comment) {
    return "";
  }
  if (startsShellComment(state, character, previous)) {
    state.comment = true;
    return "";
  }
  updateShellQuote(state, character);
  state.escaped = !state.escaped && character === "\\" && state.quote !== "'";
  return character;
}

function startsShellComment(
  state: ShellState,
  character: string,
  previous: string,
): boolean {
  const boundary = previous === "" || /[\s;&|()<>]/u.test(previous);
  return !state.escaped && state.quote === "" && character === "#" && boundary;
}

function updateShellQuote(state: ShellState, character: string): void {
  if (state.escaped || !["'", '"', "`"].includes(character)) {
    return;
  }
  if (state.quote === character) {
    state.quote = "";
  } else if (state.quote === "") {
    state.quote = character;
  }
}

function validateInstall(text: string, file: string, service: string): void {
  for (const command of text.split(/[;&|\n]+/u)) {
    if (
      !/\b(?:pnpm|npm|yarn)\b[^;&]*\b(?:install|deploy|ci)\b/u.test(command)
    ) {
      continue;
    }
    const filter = installFilter(command);
    const expected = `${service}${/\bdeploy\b/u.test(command) ? "" : "..."}`;
    if (!/\bpnpm\b/u.test(command) || filter !== expected) {
      throw new ImageInputError({
        message: `Unscoped pnpm install/deploy in ${file}; expected --filter ${expected}`,
      });
    }
  }
}

function installFilter(command: string): string | undefined {
  return /(?:--filter(?:=|\s+)|-F\s+)([^\s]+)/u
    .exec(command)?.[1]
    ?.replace(/^["']|["']$/gu, "");
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
