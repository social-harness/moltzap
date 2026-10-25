/** @file Workspace module resolution shared by packed host hashes and committed image keys. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/** Package identity and path relative to that package's root. */
export interface Module {
  readonly name: string;
  readonly relative: string;
}

/** Adapts resolution to packed files or a committed source tree. */
export interface ModuleReader {
  readonly read: (file: string) => string;
  readonly locate: (root: string, relative: string) => string | undefined;
  readonly missing?: (specifier: string) => never;
}

/** Node selects the first target; image processes can activate several conditions. */
export interface Resolution {
  readonly conditions: readonly string[];
  readonly all: boolean;
}

const PACKED_READER: ModuleReader = {
  read: (file) => readFileSync(file, "utf8"),
  locate: (root, relative) =>
    existsSync(path.join(root, relative)) ? relative : undefined,
};

/** Follows runtime edges, leaving declarations and type-only imports outside the runtime graph. */
export function moduleGraph(
  seeds: readonly Module[],
  roots: ReadonlyMap<string, string>,
  resolution: Resolution,
  reader: ModuleReader = PACKED_READER,
): readonly Module[] {
  const pending = [...seeds];
  const seen = new Map<string, Module>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const label = `${next.name}/${next.relative}`;
    if (seen.has(label)) {
      continue;
    }
    seen.set(label, next);
    const root = roots.get(next.name) ?? "";
    const text = reader.read(path.join(root, next.relative));
    if (isRuntimeModule(next, root, text, reader)) {
      for (const specifier of runtimeImports(text)) {
        pending.push(
          ...resolve(next, specifier, { roots, resolution, reader }, new Set()),
        );
      }
    }
  }
  return [...seen.values()];
}

/** TypeScript's syntax tree distinguishes erased imports from imports executed by Node. */
export function runtimeImports(text: string): readonly string[] {
  const source = ts.createSourceFile(
    "module.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const found = new Set<string>();
  function visit(node: ts.Node): void {
    const specifier = runtimeSpecifier(node);
    if (specifier !== undefined) {
      found.add(specifier);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...found];
}

/** Runtime import calls include CommonJS require as well as dynamic import. */
export function runtimeCall(node: ts.CallExpression): boolean {
  return (
    node.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(node.expression) && node.expression.text === "require")
  );
}

/** Only whole-declaration import type is erased under verbatimModuleSyntax. */
export function erasedImport(clause?: ts.ImportClause): boolean {
  return clause?.phaseModifier === ts.SyntaxKind.TypeKeyword;
}

/** Declaration files never execute; manifest binaries and Node shebangs can omit an extension. */
export function runtimeModule(
  relative: string,
  text: string,
  bin = false,
): boolean {
  return (
    !/\.d\.[cm]?ts$/u.test(relative) &&
    (/\.[cm]?[jt]s$/u.test(relative) || bin || /^#![^\n]*\bnode\b/u.test(text))
  );
}

function isRuntimeModule(
  module: Module,
  root: string,
  text: string,
  reader: ModuleReader,
): boolean {
  const bin = readManifest(root, reader).bin;
  const bins = typeof bin === "string" ? [bin] : Object.values(bin ?? {});
  return runtimeModule(
    module.relative,
    text,
    bins.some(
      (target) =>
        typeof target === "string" &&
        path.posix.normalize(target) === module.relative,
    ),
  );
}

function runtimeSpecifier(node: ts.Node): string | undefined {
  if (ts.isImportDeclaration(node)) {
    return importSpecifier(node);
  }
  if (ts.isExportDeclaration(node)) {
    return exportSpecifier(node);
  }
  if (ts.isCallExpression(node) && runtimeCall(node)) {
    const [argument] = node.arguments;
    if (argument !== undefined && ts.isStringLiteralLike(argument)) {
      return argument.text;
    }
  }
  return undefined;
}

function exportSpecifier(node: ts.ExportDeclaration): string | undefined {
  if (node.isTypeOnly || node.moduleSpecifier === undefined) {
    return undefined;
  }
  return ts.isStringLiteral(node.moduleSpecifier)
    ? node.moduleSpecifier.text
    : undefined;
}

function importSpecifier(node: ts.ImportDeclaration): string | undefined {
  return !erasedImport(node.importClause) &&
    ts.isStringLiteral(node.moduleSpecifier)
    ? node.moduleSpecifier.text
    : undefined;
}

function resolve(
  from: Module,
  specifier: string,
  context: Context,
  aliases: ReadonlySet<string>,
): Module[] {
  if (specifier.startsWith(".")) {
    const target = path.posix.normalize(
      path.posix.join(path.posix.dirname(from.relative), specifier),
    );
    return locate(from.name, target, context);
  }
  if (specifier.startsWith("#")) {
    return resolveAlias(from, specifier, context, aliases);
  }
  return resolvePackage(specifier, context);
}

function resolveAlias(
  from: Module,
  specifier: string,
  context: Context,
  aliases: ReadonlySet<string>,
): Module[] {
  if (aliases.has(specifier)) {
    context.reader.missing?.(specifier);
    return [];
  }
  const root = context.roots.get(from.name) ?? "";
  const entry = subpathEntry(
    readManifest(root, context.reader).imports,
    specifier,
  );
  if (!entry.matched) {
    context.reader.missing?.(`${root}/package.json (${specifier})`);
  }
  const seen = new Set([...aliases, specifier]);
  return targets(entry.value, context.resolution).flatMap((target) =>
    resolve({ ...from, relative: "index.js" }, target, context, seen),
  );
}

function resolvePackage(specifier: string, context: Context): Module[] {
  const parts = specifier.split("/");
  const count = specifier.startsWith("@") ? 2 : 1;
  const name = parts.slice(0, count).join("/");
  const root = context.roots.get(name);
  if (root === undefined) {
    return [];
  }
  const subpath =
    parts.length === count ? "." : `./${parts.slice(count).join("/")}`;
  const manifest = readManifest(root, context.reader);
  const entry =
    manifest.exports === undefined
      ? {
          matched: true,
          value: legacyTarget(manifest, subpath),
        }
      : exportEntry(manifest.exports, subpath);
  if (!entry.matched) {
    context.reader.missing?.(`${root}/package.json (${specifier})`);
  }
  return targets(entry.value, context.resolution).flatMap((target) =>
    locate(name, target, context),
  );
}

function locate(name: string, target: string, context: Context): Module[] {
  const relative = context.reader.locate(context.roots.get(name) ?? "", target);
  if (relative === undefined) {
    context.reader.missing?.(
      path.posix.join(context.roots.get(name) ?? "", target),
    );
    return [];
  }
  return [{ name, relative }];
}

function readManifest(
  root: string,
  reader: ModuleReader,
): Record<string, unknown> {
  const value: unknown = JSON.parse(
    reader.read(path.join(root, "package.json")),
  );
  return typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function exportEntry(value: unknown, subpath: string) {
  if (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).some((key) => key.startsWith("."))
  ) {
    return subpathEntry(value, subpath);
  }
  return {
    matched: subpath === ".",
    value: subpath === "." ? value : undefined,
  };
}

function subpathEntry(
  value: unknown,
  subpath: string,
): { readonly matched: boolean; readonly value: unknown } {
  const entries =
    typeof value === "object" && value !== null ? Object.entries(value) : [];
  const exact = entries.find(([key]) => key === subpath);
  if (exact !== undefined) {
    return { matched: true, value: exact[1] };
  }
  const patterns = entries
    .filter(([key]) => key.includes("*"))
    .sort(
      ([left], [right]) =>
        right.indexOf("*") - left.indexOf("*") || right.length - left.length,
    );
  for (const [key, target] of patterns) {
    const [prefix = "", suffix = ""] = key.split("*");
    if (matchesPattern(subpath, prefix, suffix)) {
      const replacement = subpath.slice(
        prefix.length,
        subpath.length - suffix.length,
      );
      return { matched: true, value: replacePattern(target, replacement) };
    }
  }
  return { matched: false, value: undefined };
}

function replacePattern(value: unknown, replacement: string): unknown {
  if (typeof value === "string") {
    return value.replaceAll("*", replacement);
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => replacePattern(item, replacement));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        replacePattern(item, replacement),
      ]),
    );
  }
  return value;
}

/** Selects in manifest order for Node, or unions every active target for image processes. */
function targets(value: unknown, resolution: Resolution): string[] {
  return selectedTargets(value, resolution) ?? [];
}

function matchesPattern(
  value: string,
  prefix: string,
  suffix: string,
): boolean {
  return (
    value.startsWith(prefix) &&
    value.endsWith(suffix) &&
    value.length >= prefix.length + suffix.length
  );
}

function legacyTarget(
  manifest: Record<string, unknown>,
  subpath: string,
): unknown {
  return subpath === "." ? (manifest.main ?? "./index.js") : subpath;
}

function selectedTargets(
  value: unknown,
  resolution: Resolution,
): string[] | undefined {
  if (typeof value === "string") {
    return [value];
  }
  if (value === null) {
    return [];
  }
  if (typeof value !== "object") {
    return undefined;
  }
  return activeTargets(value, resolution);
}

function activeTargets(
  value: object,
  resolution: Resolution,
): string[] | undefined {
  const array = Array.isArray(value);
  const active: readonly unknown[] = array
    ? value
    : Object.entries(value)
        .filter(([key]) => resolution.conditions.includes(key))
        .map(([, item]: [string, unknown]) => item);
  if (resolution.all) {
    return active.flatMap(
      (item: unknown) => selectedTargets(item, resolution) ?? [],
    );
  }
  for (const item of active) {
    const found = selectedTargets(item, resolution);
    if (usableTarget(array, found)) {
      return found;
    }
  }
  return array ? [] : undefined;
}

function usableTarget(array: boolean, found?: readonly string[]): boolean {
  return found !== undefined && (!array || found.length > 0);
}

interface Context {
  readonly roots: ReadonlyMap<string, string>;
  readonly resolution: Resolution;
  readonly reader: ModuleReader;
}
