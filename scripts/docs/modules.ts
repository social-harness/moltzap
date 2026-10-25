/**
 * @file Workspace per-folder MODULE.md + Mintlify MDX generator.
 *
 * Folders opt in by adding a leading file-level JSDoc block to
 * `index.ts`. Output is deterministic: sorted exports, LF endings,
 * stable section order.
 */
import { FileSystem, Path } from "@effect/platform";
import { Effect, Schema } from "effect";
import * as ts from "typescript";
import { FINAL_PACKAGE_DIRS, FINAL_PACKAGES } from "../architecture/boundary-contract.ts";
import { extractSignatureText } from "./signature-extract.ts";
import {
  folderOf,
  ReflectionKind,
  type TypeDocCache,
  type TypeDocExport,
} from "./typedoc-load.ts";

/** Describes the result of module render. */
export interface ModuleRenderResult {
  readonly folder: string;
  readonly h1: string;
  readonly pageSlug: string;
}

/** Describes module render config. */
export interface ModuleRenderConfig {
  readonly workspaceRoot: string;
  readonly docsModulesDir: string;
}

/**
 * Base URL for source links emitted in the published MDX twin. MODULE.md
 * uses in-tree relative paths; the MDX lives under `docs/modules/` and
 * needs an absolute permalink so the rendered page resolves under
 * Mintlify.
 */
const SOURCE_LINK_BASE = "https://github.com/social-harness/moltzap/blob/main";

/**
 * Final package roots are required generator inputs even before their
 * public barrels contain behavioral exports.
 */
const REQUIRED_MODULE_FOLDERS = FINAL_PACKAGE_DIRS.filter(
  (dir) => !dir.endsWith("-channel"),
).map((dir) => `packages/${dir}/src`);

/** Package projects required by product module documentation. */
const REQUIRED_PACKAGE_NAMES = FINAL_PACKAGE_DIRS.filter((dir) => !dir.endsWith("-channel")).map((dir) => FINAL_PACKAGES[dir].npmName);

/** Public production subpaths documented by the module generator. */
export const REQUIRED_PACKAGE_SUBPATHS = FINAL_PACKAGE_DIRS.flatMap((dir) =>
  Object.entries(FINAL_PACKAGES[dir].exports)
    .filter(([entry, target]) => entry !== "." && !target.testOnly && !target.internalOnly)
    .map(([entry]) => `${FINAL_PACKAGES[dir].npmName}/${entry.slice(2)}`),
);

interface LinkContext {
  readonly mode: "module-md" | "mdx";
  readonly displayName?: string;
  readonly headingLevel?: number;
}

interface EnrichedExport extends TypeDocExport {
  readonly signatureText: string | null;
}

interface EnrichedSubpath {
  readonly importPath: string;
  readonly exports: readonly EnrichedExport[];
}

interface ResolvedExportDeclaration {
  readonly source?: TypeDocExport["sources"][number];
  readonly signatureText: string | null;
}

interface MissingJsDoc {
  readonly _tag: "MissingJsDoc";
  readonly folder: string;
}

const packageManifest = Schema.parseJson(
  Schema.Struct({ name: Schema.NonEmptyString }),
);

const REFLECTION_KIND_BY_DECLARATION_SYNTAX = new Map<ts.SyntaxKind, number>([
  [ts.SyntaxKind.VariableDeclaration, ReflectionKind.Variable],
  [ts.SyntaxKind.TypeAliasDeclaration, ReflectionKind.TypeAlias],
  [ts.SyntaxKind.InterfaceDeclaration, ReflectionKind.Interface],
  [ts.SyntaxKind.ClassDeclaration, ReflectionKind.Class],
  [ts.SyntaxKind.FunctionDeclaration, ReflectionKind.Function],
  [ts.SyntaxKind.EnumDeclaration, ReflectionKind.Enum],
  [ts.SyntaxKind.ModuleDeclaration, ReflectionKind.Module],
]);

interface RenderArgs {
  readonly h1: string;
  readonly subtitle: string;
  readonly purpose: string;
  readonly exports: readonly EnrichedExport[];
  readonly subpaths: readonly EnrichedSubpath[];
  readonly sourceFiles: readonly string[];
  readonly folder: string;
  readonly path: Path.Path;
  readonly linkContext: LinkContext;
}

/**
 * Render MODULE.md + Mintlify MDX for every folder whose `index.ts`
 * has a leading file-level JSDoc block. Folders without that block
 * print a warning and are skipped (loud, not silent). After rendering,
 * orphan MDX twins (slugs no longer produced by the generator) and
 * orphan MODULE.md files (folders whose `index.ts` is gone) are
 * deleted so the published docs tree matches the source tree.
 */
export function generateModuleDocs(
  cache: TypeDocCache,
  config: ModuleRenderConfig,
): Effect.Effect<
  readonly ModuleRenderResult[],
  never,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    yield* requireTypeDocInputs(cache);
    const folders = yield* discoverFolders(cache, config);
    const rendered: ModuleRenderResult[] = [];
    const warnings: string[] = [];
    for (const folder of folders) {
      const result = yield* renderFolder(folder, cache, config, path).pipe(
        Effect.catchTag("MissingJsDoc", (e) => {
          warnings.push(e.folder);
          return Effect.succeed(null);
        }),
      );
      if (result !== null) {
        rendered.push(result);
      }
    }
    if (warnings.length > 0) {
      yield* emitWarnings(warnings);
    }
    const renderedFolders = new Set(rendered.map((result) => result.folder));
    const missingRequiredFolders = REQUIRED_MODULE_FOLDERS.filter(
      (folder) => !renderedFolders.has(folder),
    );
    if (missingRequiredFolders.length > 0) {
      return yield* Effect.dieMessage(
        `Required MODULE documentation was not rendered for: ${missingRequiredFolders.join(", ")}`,
      );
    }
    yield* pruneOrphans(rendered, config, path);
    return rendered;
  }).pipe(Effect.withSpan("generateModuleDocs"));
}

/**
 * Resolve the declaration represented by one TypeDoc reflection.
 *
 * TypeDoc reports every source in a declaration-merged symbol, so the first
 * location can belong to a different reflection kind. TypeScript identifies
 * the declaration whose name and syntax kind match the reflection.
 *
 */
export function resolveExportDeclaration(
  ex: TypeDocExport,
  sourceByFile: ReadonlyMap<string, string>,
): ResolvedExportDeclaration {
  return resolveExportDeclarationWithCache(ex, sourceByFile, new Map());
}

/**
 * Read the summary of a TypeScript source's leading JSDoc block, or null
 * when no complete leading JSDoc block exists.
 *
 * If the block starts with the &amp;#64;file tag, the prose after that tag
 * becomes the summary. The summary ends before the first subsequent block
 * tag, with asterisk markup removed.
 */
export function readLeadingJsDoc(source: string): string | null {
  const block = readLeadingJsDocBlock(source);
  if (block === null) {
    return null;
  }
  const lines = block
    .replace(/^\/\*\*/, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?/, "").trimEnd());
  const stripped = lines.join("\n").trim();
  const summary = stripped.startsWith("@file ")
    ? stripped.slice("@file ".length).trim()
    : stripped;
  return summary.split(/^@\w+(?=\s|$)/m, 1)[0]?.trim() ?? "";
}

/**
 * Parse a `&amp;#64;failure ErrName when prose` tag content into
 * structured form. This is the single source of truth for the parse rule;
 * the tag itself is registered in `eslint.shared.ts`.
 */
export function parseFailureTag(text: string): {
  readonly errorName: string;
  readonly when: string | null;
} {
  const t = text.trim();
  const ix = t.indexOf(" when ");
  if (ix === -1) {
    const space = t.indexOf(" ");
    if (space === -1) {
      return { errorName: t, when: null };
    }
    return { errorName: t.slice(0, space), when: t.slice(space + 1).trim() };
  }
  return { errorName: t.slice(0, ix).trim(), when: t.slice(ix + 6).trim() };
}

/**
 * Delete docs/modules MDX files whose slug is not produced by this
 * pass, and delete `MODULE.md` siblings whose folder is no longer in
 * the rendered set. Stale pages from a previous generator shape stay
 * referenced from no navigation entry and confuse `docs:check:drift`;
 * pruning closes the loop.
 */
function pruneOrphans(
  rendered: readonly ModuleRenderResult[],
  config: ModuleRenderConfig,
  path: Path.Path,
): Effect.Effect<void, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const liveSlugs = new Set(rendered.map((r) => r.pageSlug));
    const liveFolders = new Set(rendered.map((r) => r.folder));
    const mdxPaths = yield* listFilesWithSuffix(
      fs,
      config.docsModulesDir,
      ".mdx",
    );
    for (const abs of mdxPaths) {
      const rel = path.relative(config.docsModulesDir, abs);
      const slug = rel.replace(/\.mdx$/, "");
      if (liveSlugs.has(slug)) {
        continue;
      }
      yield* fs.remove(abs).pipe(Effect.orDie);
      process.stdout.write(`  pruned orphan MDX: ${rel}\n`);
    }
    const modulePaths = yield* listFilesWithSuffix(
      fs,
      path.resolve(config.workspaceRoot, "packages"),
      "MODULE.md",
    );
    for (const abs of modulePaths) {
      const folder = path.relative(config.workspaceRoot, path.dirname(abs));
      if (liveFolders.has(folder)) {
        continue;
      }
      yield* fs.remove(abs).pipe(Effect.orDie);
      process.stdout.write(`  pruned orphan MODULE.md: ${folder}\n`);
    }
  });
}

function emitWarnings(folders: readonly string[]): Effect.Effect<void> {
  return Effect.sync(() => {
    process.stderr.write(
      `\nMODULE generation skipped ${folders.length} folder(s) without file-level JSDoc on index.ts:\n`,
    );
    for (const f of folders) {
      process.stderr.write(
        `  ${f}/index.ts: add a leading /** ... */ block to opt in\n`,
      );
    }
    process.stderr.write("\n");
  });
}

function discoverFolders(
  cache: TypeDocCache,
  config: ModuleRenderConfig,
): Effect.Effect<readonly string[], never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const seen = new Set<string>(REQUIRED_MODULE_FOLDERS);
    for (const ex of cache.all) {
      const folder = folderOf(ex);
      if (yield* shouldDocumentFolder(folder, config, fs, path)) {
        seen.add(folder);
      }
    }
    return [...seen].sort((left, right) => left.localeCompare(right));
  });
}

function renderFolder(
  folder: string,
  cache: TypeDocCache,
  config: ModuleRenderConfig,
  path: Path.Path,
): Effect.Effect<ModuleRenderResult, MissingJsDoc, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const purpose = yield* readModulePurpose(folder, config, fs, path);
    const packageRoot = isPackageRoot(folder);
    const packageName = packageRoot
      ? yield* readPackageName(folder, config, fs, path)
      : null;
    const enriched = yield* enrichWithSignatures(
      folderExports(cache, packageName, folder),
      fs,
      path,
      config,
    );
    const subpaths = yield* enrichPackageSubpaths(packageName, cache, {
      fs,
      path,
      config,
    });
    const documentedExports = [
      ...enriched,
      ...subpaths.flatMap((subpath) => subpath.exports),
    ];
    const sourceFiles = isRequiredModuleFolder(folder)
      ? yield* collectProductionSourceFiles(folder, config, fs, path)
      : documentedExports.flatMap((entry) =>
          entry.sources.map((source) => source.fileName),
        );
    const pageSlug = modulePageSlug(folder);
    yield* writeModulePages(
      {
        purpose,
        exports: enriched,
        subpaths,
        sourceFiles,
        folder,
        path,
      },
      pageSlug,
      config,
      fs,
    );
    return { folder, h1: `# ${pageSlug}`, pageSlug };
  });
}

function collectProductionSourceFiles(
  folder: string,
  config: ModuleRenderConfig,
  fs: FileSystem.FileSystem,
  path: Path.Path,
): Effect.Effect<readonly string[]> {
  const sourceRoot = path.resolve(config.workspaceRoot, folder);
  return Effect.all([
    listFilesWithSuffix(fs, sourceRoot, ".ts"),
    listFilesWithSuffix(fs, sourceRoot, "README.md"),
  ]).pipe(
    Effect.map((files) =>
      files
        .flat()
        .map((file) => path.relative(config.workspaceRoot, file))
        .filter(
          (file) =>
            !file.includes("/__tests__/") &&
            !file.endsWith(".test.ts") &&
            !file.endsWith(".types-check.ts"),
        )
        .sort((left, right) => left.localeCompare(right)),
    ),
  );
}

function listFilesWithSuffix(
  fs: FileSystem.FileSystem,
  root: string,
  suffix: string,
): Effect.Effect<readonly string[]> {
  return Effect.gen(function* () {
    const out: string[] = [];
    const rootExists = yield* fs.exists(root).pipe(Effect.orDie);
    if (!rootExists) {
      return [];
    }
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop();
      if (dir === undefined) {
        break;
      }
      const entries = yield* fs.readDirectory(dir).pipe(Effect.orDie);
      for (const name of entries) {
        yield* collectFileWithSuffix({ fs, suffix, stack, out }, dir, name);
      }
    }
    return out;
  });
}

function readPackageName(
  folder: string,
  config: ModuleRenderConfig,
  fs: FileSystem.FileSystem,
  path: Path.Path,
): Effect.Effect<string> {
  return fs
    .readFileString(
      path.resolve(config.workspaceRoot, folder, "..", "package.json"),
    )
    .pipe(
      Effect.flatMap(Schema.decodeUnknown(packageManifest)),
      Effect.map((manifest) => manifest.name),
      Effect.orDie,
    );
}

/**
 * Return the collision-free generated page slug for a module folder.
 */
function modulePageSlug(folder: string): string {
  const parts = sourcePathParts(folder);
  const pkg = packageSlugFor(parts);
  const modulePath = pathFromPackageSrc(parts);
  const page = modulePath.length > 0 ? modulePath : (parts.at(-1) ?? "unknown");
  return `${pkg}/${page}`;
}

function packageSlugFor(parts: readonly string[]): string {
  if (parts.length < 2 || parts[0] !== "packages") {
    return "unknown";
  }
  return parts[1] ?? "unknown";
}

function pathFromPackageSrc(parts: readonly string[]): string {
  const srcIx = parts.indexOf("src");
  if (srcIx === -1) {
    return "";
  }
  return parts.slice(srcIx + 1).join("/");
}

function requireTypeDocInputs(cache: TypeDocCache): Effect.Effect<void> {
  return Effect.gen(function* () {
    const missingTypeDocPackages = REQUIRED_PACKAGE_NAMES.filter(
      (packageName) => !cache.byPackageEntrypoint.has(packageName),
    );
    if (missingTypeDocPackages.length > 0) {
      return yield* Effect.dieMessage(
        `Required TypeDoc packages were not loaded: ${missingTypeDocPackages.join(", ")}`,
      );
    }
    const missingPackageSubpaths = REQUIRED_PACKAGE_SUBPATHS.filter(
      (importPath) =>
        (cache.byPackageEntrypoint.get(importPath)?.length ?? 0) === 0,
    );
    if (missingPackageSubpaths.length > 0) {
      return yield* Effect.dieMessage(
        `Required TypeDoc package subpaths were not loaded: ${missingPackageSubpaths.join(", ")}`,
      );
    }
  });
}

function shouldDocumentFolder(
  folder: string,
  config: ModuleRenderConfig,
  fs: FileSystem.FileSystem,
  path: Path.Path,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    if (!isDocumentedSourceFolder(folder)) {
      return false;
    }
    const indexPath = path.resolve(config.workspaceRoot, folder, "index.ts");
    const hasIndex = yield* fs.exists(indexPath).pipe(Effect.orDie);
    if (!hasIndex) {
      return false;
    }
    const indexSource = yield* fs.readFileString(indexPath).pipe(Effect.orDie);
    if (isInternalModuleSource(indexSource)) {
      return false;
    }
    if (isPackageRoot(folder)) {
      if (isEmptyBarrelSource(indexSource) && !isRequiredModuleFolder(folder)) {
        return false;
      }
    }
    return true;
  });
}

function isDocumentedSourceFolder(folder: string): boolean {
  return folder.startsWith("packages/");
}

/**
 * True when `src/index.ts` is intentionally empty (`export {};`) — no
 * value re-exports. Used to skip MODULE/MDX emission for packages whose
 * public surface is the bin, not a programmatic API.
 */
function isEmptyBarrelSource(source: string): boolean {
  const cleaned = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/export\s*\{\s*\}\s*;?/g, "")
    .trim();
  return cleaned.length === 0;
}

function isInternalModuleSource(source: string): boolean {
  const block = readLeadingJsDocBlock(source);
  return block !== null && /(^|\s)@internal(\s|$)/.test(block);
}

/** The leading JSDoc block of a source with its tags, or null when it has none. */
function readLeadingJsDocBlock(source: string): string | null {
  const trimmed = source.trimStart();
  if (!trimmed.startsWith("/**")) {
    return null;
  }
  const closeIx = trimmed.indexOf("*/");
  if (closeIx === -1) {
    return null;
  }
  return trimmed.slice(0, closeIx);
}

/**
 * A workspace package's `src` folder is its package root. Sub-folders below
 * `src/` keep their own opt-in via the leading-JSDoc gate in `renderFolder`.
 */
function isPackageRoot(folder: string): boolean {
  const parts = sourcePathParts(folder);
  return parts.length === 3 && parts[0] === "packages" && parts[2] === "src";
}

function sourcePathParts(folder: string): readonly string[] {
  return folder.split("/");
}

function writeModulePages(
  input: Omit<RenderArgs, "linkContext" | "h1" | "subtitle">,
  pageSlug: string,
  config: ModuleRenderConfig,
  fs: FileSystem.FileSystem,
): Effect.Effect<void> {
  const args = {
    ...input,
    h1: `# ${pageSlug}`,
    subtitle: `_\`${input.folder}\`_`,
  };
  return Effect.gen(function* () {
    const moduleMdBody = renderMarkdown({
      ...args,
      linkContext: { mode: "module-md" },
    });
    const mdxBody = renderMarkdown({ ...args, linkContext: { mode: "mdx" } });
    yield* writeAtomic(
      fs,
      args.path.resolve(config.workspaceRoot, args.folder, "MODULE.md"),
      moduleMdBody,
    );
    yield* writeAtomic(
      fs,
      args.path.resolve(config.docsModulesDir, `${pageSlug}.mdx`),
      `${renderFrontmatter({ title: pageSlug, description: firstSentence(args.purpose) })}\n${mdxBody}`,
    );
  });
}

function writeAtomic(
  fs: FileSystem.FileSystem,
  absolutePath: string,
  content: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const dir = absolutePath.slice(0, absolutePath.lastIndexOf("/"));
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.orDie);
    const tmp = `${absolutePath}.tmp.${process.pid}`;
    yield* fs.writeFileString(tmp, content).pipe(Effect.orDie);
    yield* fs.rename(tmp, absolutePath).pipe(Effect.orDie);
  });
}

function renderMarkdown(args: RenderArgs): string {
  const sorted = [...args.exports].sort((a, b) => a.name.localeCompare(b.name));
  const sections: string[][] = [
    renderHeader(args),
    renderPublicSurface(sorted, args.folder, args.path, args.linkContext),
    renderPackageSubpaths(
      args.subpaths,
      args.folder,
      args.path,
      args.linkContext,
    ),
    renderFilesSection(args.sourceFiles, args.folder, args.path),
  ];
  return sections.flat().join("\n");
}

function renderHeader(args: RenderArgs): string[] {
  return [
    args.h1,
    "",
    args.subtitle,
    "",
    "## Purpose",
    "",
    args.purpose.trim(),
    "",
  ];
}

function renderPublicSurface(
  sorted: readonly EnrichedExport[],
  folder: string,
  path: Path.Path,
  link: LinkContext,
): string[] {
  const lines: string[] = ["## Public surface", ""];
  if (sorted.length === 0) {
    lines.push("_No exports surfaced from this folder._", "");
    return lines;
  }
  const nameCounts = new Map<string, number>();
  for (const entry of sorted) {
    nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  }
  for (const ex of sorted) {
    const displayName =
      isRequiredModuleFolder(folder) && (nameCounts.get(ex.name) ?? 0) > 1
        ? `${ex.name} (${declarationRole(ex)})`
        : ex.name;
    lines.push(
      ...renderExport(ex, folder, path, {
        ...link,
        displayName,
      }),
    );
  }
  return lines;
}

function renderPackageSubpaths(
  subpaths: readonly EnrichedSubpath[],
  folder: string,
  path: Path.Path,
  link: LinkContext,
): string[] {
  if (subpaths.length === 0) {
    return [];
  }
  const lines: string[] = ["## Package subpaths", ""];
  for (const subpath of subpaths) {
    lines.push(...renderSubpath(subpath, folder, path, link));
  }
  return lines;
}

function renderFilesSection(
  sourceFiles: readonly string[],
  folder: string,
  path: Path.Path,
): string[] {
  const lines: string[] = ["## Files", ""];
  const files = [...new Set(sourceFiles)]
    .filter((f) => f.startsWith(`${folder}/`))
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0) {
    lines.push("_No source files tracked under this folder by TypeDoc._");
  } else {
    for (const f of files) {
      const displayPath = isRequiredModuleFolder(folder)
        ? path.relative(folder, f)
        : path.basename(f);
      lines.push(`- \`${displayPath}\``);
    }
  }
  lines.push("");
  return lines;
}

function isRequiredModuleFolder(folder: string): boolean {
  return REQUIRED_MODULE_FOLDERS.some((required) => required === folder);
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const m = /^(.+?[.!?])(\s|$)/s.exec(trimmed);
  return m?.[1]?.trim() ?? trimmed.split("\n")[0]?.trim() ?? "";
}

function renderFrontmatter(args: {
  readonly title: string;
  readonly description: string;
}): string {
  const t = args.title.replace(/"/g, '\\"');
  const d = args.description.replace(/"/g, '\\"');
  return `---\ntitle: "${t}"\ndescription: "${d}"\n---\n`;
}

function collectFileWithSuffix(
  ctx: {
    fs: FileSystem.FileSystem;
    suffix: string;
    stack: string[];
    out: string[];
  },
  dir: string,
  name: string,
): Effect.Effect<void> {
  const { fs, suffix, stack, out } = ctx;
  return Effect.gen(function* () {
    if (name === "node_modules" || name === "dist") {
      return;
    }
    const abs = `${dir}/${name}`;
    const stat = yield* fs.stat(abs).pipe(Effect.orDie);
    if (stat.type === "Directory") {
      stack.push(abs);
    } else if (name.endsWith(suffix)) {
      out.push(abs);
    }
  });
}

function renderSubpath(
  subpath: EnrichedSubpath,
  folder: string,
  path: Path.Path,
  link: LinkContext,
): string[] {
  const lines: string[] = [];
  lines.push(`### \`${subpath.importPath}\``, "");
  const nameCounts = new Map<string, number>();
  for (const entry of subpath.exports) {
    nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  }
  for (const entry of subpath.exports) {
    const qualifiedName =
      entry.namespace === null
        ? entry.name
        : `${entry.namespace}.${entry.name}`;
    const displayName =
      (nameCounts.get(entry.name) ?? 0) > 1
        ? `${qualifiedName} (${declarationRole(entry)})`
        : qualifiedName;
    lines.push(
      ...renderExport(entry, folder, path, {
        ...link,
        displayName,
        headingLevel: 4,
      }),
    );
  }
  return lines;
}

function declarationRole(ex: EnrichedExport): string {
  if (
    ex.kind === ReflectionKind.TypeAlias ||
    ex.kind === ReflectionKind.Interface
  ) {
    return "type";
  }
  if (
    ex.kind === ReflectionKind.Variable ||
    ex.kind === ReflectionKind.Function
  ) {
    return "value";
  }
  return ex.kindString.toLowerCase();
}

function renderExport(
  ex: EnrichedExport,
  folder: string,
  path: Path.Path,
  link: LinkContext,
): string[] {
  const prose = (text: string) =>
    link.mode === "mdx" ? escapeMdxProse(text) : text;
  const heading = "#".repeat(link.headingLevel ?? 3);
  const lines: string[] = [
    `${heading} ${exportLink(ex, folder, path, link)}`,
    "",
    `_${ex.kindString}_`,
    "",
  ];
  if (ex.signatureText) {
    lines.push("```ts", ex.signatureText, "```", "");
  }
  const summary = ex.comment?.summary.trim();
  if (summary) {
    lines.push(prose(summary), "");
  }
  lines.push(...renderFailures(ex));
  const returns = ex.comment?.tags.find((t) => t.tag === "@returns")?.content;
  if (returns) {
    lines.push(`**Returns:** ${prose(returns)}`, "");
  }
  return lines;
}

/**
 * Escape MDX-significant characters in JSDoc prose. MDX parses a bare open-angle
 * as a JSX tag and a bare open-brace as an expression, so an un-fenced
 * `Schema&lt;T>` or `{ onExcessProperty }` in a summary is a parse error on the
 * Mintlify page. Escape both to their HTML entities — but only OUTSIDE
 * inline-code backtick spans, where MDX already treats the content literally.
 * The MODULE.md twin (GitHub-rendered Markdown) needs no escaping, so this runs
 * only in `mdx` mode.
 */
function escapeMdxProse(text: string): string {
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (line.trimStart().startsWith("```")) {
        inFence = !inFence;
        return line;
      }

      if (inFence || /^ {4,}/.test(line)) {
        return line;
      }

      return line
        .split(/(`[^`]*`)/)
        .map((segment, i) =>
          i % 2 === 1
            ? segment
            : segment.replaceAll("<", "&lt;").replaceAll("{", "&#123;"),
        )
        .join("");
    })
    .join("\n");
}

function exportLink(
  ex: EnrichedExport,
  folder: string,
  path: Path.Path,
  link: LinkContext,
): string {
  const displayName = link.displayName ?? ex.name;
  const src = ex.sources[0];
  if (!src) {
    return `\`${displayName}\``;
  }
  if (link.mode === "module-md") {
    return `[\`${displayName}\`](./${path.relative(folder, src.fileName)}#L${src.line})`;
  }

  return `[\`${displayName}\`](${sourcePermalink(src.fileName, src.line)})`;
}

function renderFailures(ex: EnrichedExport): string[] {
  const failures = ex.comment?.tags.filter((t) => t.tag === "@failure") ?? [];
  if (failures.length === 0) {
    return [];
  }
  const lines: string[] = ["**Fails with:**", ""];
  for (const f of failures) {
    const parsed = parseFailureTag(f.content);
    const suffix = parsed.when ? ` — ${parsed.when}` : "";
    lines.push(`- \`${parsed.errorName}\`${suffix}`);
  }
  lines.push("");
  return lines;
}

/**
 * Build a source permalink on `main`, the only branch documentation cites.
 */
function sourcePermalink(fileName: string, line: number): string {
  return `${SOURCE_LINK_BASE}/${fileName}#L${line}`;
}

function enrichPackageSubpaths(
  packageName: string | null,
  cache: TypeDocCache,
  ctx: {
    fs: FileSystem.FileSystem;
    path: Path.Path;
    config: ModuleRenderConfig;
  },
): Effect.Effect<readonly EnrichedSubpath[]> {
  const { fs, path, config } = ctx;
  return Effect.gen(function* () {
    const subpaths =
      packageName === null
        ? []
        : yield* Effect.forEach(
            packageSubpathsForPackage(cache, packageName),
            (subpath) =>
              enrichWithSignatures(subpath.exports, fs, path, config).pipe(
                Effect.map(
                  (subpathExports): EnrichedSubpath => ({
                    importPath: subpath.importPath,
                    exports: subpathExports,
                  }),
                ),
              ),
            { concurrency: "inherit" },
          );
    return subpaths;
  });
}

/**
 * Returns the documented public subpaths exported by one package.
 *
 */
function packageSubpathsForPackage(
  cache: TypeDocCache,
  packageName: string,
): ReadonlyArray<
  Readonly<{
    importPath: string;
    exports: readonly TypeDocExport[];
  }>
> {
  return REQUIRED_PACKAGE_SUBPATHS.filter((importPath) =>
    importPath.startsWith(`${packageName}/`),
  ).map((importPath) => ({
    importPath,
    exports: cache.byPackageEntrypoint.get(importPath) ?? [],
  }));
}

function enrichWithSignatures(
  exports: readonly TypeDocExport[],
  fs: FileSystem.FileSystem,
  path: Path.Path,
  config: ModuleRenderConfig,
): Effect.Effect<readonly EnrichedExport[]> {
  return Effect.gen(function* () {
    const fileCache = new Map<string, string>();
    const parsedFileCache = new Map<string, ts.SourceFile>();
    const enriched: EnrichedExport[] = [];
    for (const ex of exports) {
      if (
        ex.kind === ReflectionKind.Module ||
        ex.kind === ReflectionKind.Namespace
      ) {
        enriched.push({ ...ex, signatureText: null });
        continue;
      }
      yield* cacheExportSources(ex, fileCache, { fs, path, config });
      const resolved = resolveExportDeclarationWithCache(
        ex,
        fileCache,
        parsedFileCache,
      );
      if (resolved.source === undefined) {
        enriched.push({ ...ex, signatureText: null });
      } else {
        enriched.push({
          ...ex,
          sources: [
            resolved.source,
            ...ex.sources.filter((source) => source !== resolved.source),
          ],
          signatureText: resolved.signatureText,
        });
      }
    }
    return enriched;
  });
}

function resolveExportDeclarationWithCache(
  ex: TypeDocExport,
  sourceByFile: ReadonlyMap<string, string>,
  parsedFileCache: Map<string, ts.SourceFile>,
): ResolvedExportDeclaration {
  const source =
    ex.sources.length > 1
      ? ex.sources.find((candidate) =>
          sourceMatchesExport(candidate, ex, sourceByFile, parsedFileCache),
        )
      : ex.sources[0];
  const fallbackSource = source ?? ex.sources[0];
  if (fallbackSource === undefined) {
    return { signatureText: null };
  }
  const text = sourceByFile.get(fallbackSource.fileName) ?? "";
  return {
    source: fallbackSource,
    signatureText: extractSignatureText(text, fallbackSource.line, ex.kind),
  };
}

function sourceMatchesExport(
  source: TypeDocExport["sources"][number],
  ex: TypeDocExport,
  sourceByFile: ReadonlyMap<string, string>,
  parsedFileCache: Map<string, ts.SourceFile>,
): boolean {
  const text = sourceByFile.get(source.fileName);
  if (text === undefined) {
    return false;
  }
  let sourceFile = parsedFileCache.get(source.fileName);
  if (sourceFile === undefined) {
    sourceFile = ts.createSourceFile(
      source.fileName,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    parsedFileCache.set(source.fileName, sourceFile);
  }
  const lineStart = sourceFile.getLineStarts()[source.line - 1];
  if (lineStart === undefined) {
    return false;
  }
  const position = lineStart + source.character;
  if (position < lineStart || position >= sourceFile.end) {
    return false;
  }
  const name = deepestNodeAtPosition(sourceFile, sourceFile, position);
  return name.getStart(sourceFile) === position && nodeMatchesExport(name, ex);
}

function deepestNodeAtPosition(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  position: number,
): ts.Node {
  const child = node
    .getChildren(sourceFile)
    .find(
      (candidate) =>
        candidate.getStart(sourceFile) <= position &&
        position < candidate.getEnd(),
    );
  return child === undefined
    ? node
    : deepestNodeAtPosition(sourceFile, child, position);
}

function cacheExportSources(
  ex: TypeDocExport,
  fileCache: Map<string, string>,
  ctx: {
    fs: FileSystem.FileSystem;
    path: Path.Path;
    config: ModuleRenderConfig;
  },
): Effect.Effect<void> {
  const { fs, path, config } = ctx;
  return Effect.gen(function* () {
    for (const sourceLocation of ex.sources) {
      if (fileCache.has(sourceLocation.fileName)) {
        continue;
      }
      const abs = path.resolve(config.workspaceRoot, sourceLocation.fileName);
      const source = yield* fs.readFileString(abs).pipe(Effect.orDie);
      fileCache.set(sourceLocation.fileName, source);
    }
  });
}

function nodeMatchesExport(name: ts.Node, ex: TypeDocExport): boolean {
  return (
    (ts.isIdentifier(name) || ts.isStringLiteral(name)) &&
    name.text === ex.name &&
    REFLECTION_KIND_BY_DECLARATION_SYNTAX.get(name.parent.kind) === ex.kind
  );
}

function folderExports(
  cache: TypeDocCache,
  packageName: string | null,
  folder: string,
): readonly TypeDocExport[] {
  if (packageName === null) {
    return (cache.byFolder.get(folder) ?? []).filter(isBehavioral);
  }
  return (cache.byPackageEntrypoint.get(packageName) ?? []).filter(
    isBehavioral,
  );
}

function isBehavioral(ex: TypeDocExport): boolean {
  if (ex.kind === ReflectionKind.Module) {
    return false;
  }
  if (ex.kind === ReflectionKind.Reference) {
    return false;
  }

  if (ex.name.startsWith("_")) {
    return false;
  }
  if (ex.comment?.tags.some((tag) => tag.tag === "@internal")) {
    return false;
  }
  return true;
}

function readModulePurpose(
  folder: string,
  config: ModuleRenderConfig,
  fs: FileSystem.FileSystem,
  path: Path.Path,
): Effect.Effect<string, MissingJsDoc> {
  return Effect.gen(function* () {
    const indexPath = path.resolve(config.workspaceRoot, folder, "index.ts");
    const indexSource = yield* fs.readFileString(indexPath).pipe(Effect.orDie);
    const purpose = readLeadingJsDoc(indexSource);
    if (purpose === null) {
      return yield* Effect.fail(makeMissingJsDoc(folder));
    }
    return purpose;
  });
}

function makeMissingJsDoc(folder: string): MissingJsDoc {
  return {
    _tag: "MissingJsDoc",
    folder,
  };
}
