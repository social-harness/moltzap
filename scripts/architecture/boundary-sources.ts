/**
 * @file Source-text rules of the architecture boundary check: shared
 * `packages/*` export and barrel discipline, the documentation-only layer
 * notation, and the import rules that hold each product to its final DAG.
 *
 * Every rule asserts its input set is non-empty before reporting success. A
 * check that walks nothing passes vacuously and is indistinguishable from no
 * check at all.
 */
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  dependencyNames,
  FINAL_PACKAGE_DIRS,
  FINAL_PACKAGES,
  INTEGRATION_TESTS,
  type PackageDir,
} from "./boundary-contract.ts";
import {
  type BoundaryRun,
  fail,
  lineAt,
  relativePath,
  walkFiles,
} from "./boundary-run.ts";

/** One module specifier and where it starts in the source text. */
interface ImportSpecifier {
  readonly specifier: string;
  readonly index: number;
  readonly urlRelative?: true;
}

/** One file of one product whose imports are being checked. */
interface ImportSite {
  readonly dir: PackageDir;
  readonly packageDirectory: string;
  readonly file: string;
  readonly text: string;
}

interface ProductEntrySite {
  readonly target: PackageDir;
  readonly specifier: string;
  readonly line: number;
}

const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  "dist",
  "node_modules",
]);

const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

const CORE_SERVICE_TAGS =
  /\b(DbTag|EncryptionTag|ConnectionTag|ConnectionManagerTag|AgentEndpointResolverTag|NetworkSendServiceTag|AuthServiceTag|AppAuthServiceTag|AppEndpointRegistryTag|ContactsServiceTag|ConversationServiceTag|PresenceServiceTag|LeaseRegistryTag|DispatchAdmissionServiceTag|MessageServiceTag|TaskAuthorizationServiceTag|TaskServiceTag)\b/;

/**
 * Architectural numbering helps readers navigate specifications, but it
 * obscures domain ownership in executable artifacts. Source and package
 * metadata name identity, Registry, router, and Router directly.
 */
const LAYER_NOTATION_SOURCE = String.raw`(?:^|[^A-Za-z0-9])(?:[Ll][12](?=$|[^a-z0-9])|[Ll]ayer(?:[ _-]?(?:[12]|[Oo]ne|[Tt]wo))(?=$|[^a-z0-9]))`;

/**
 * Static, dynamic, re-export, and bare side-effect imports all name a module.
 * Missing any one form would let a violating import in through that keyword.
 */
const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(["'`])([^"'`]+)\1/g;

/** Resolver calls name modules without loading them. */
const RESOLVE_SPECIFIER =
  /(?:\b(?:import\.meta|require)|\bcreateRequire\s*\([^)]*\))\.resolve\s*\(\s*(["'`])([^"'`]+)\1/g;

/**
 * Apply the shared wildcard-export and `#core` barrel rules to every package
 * TypeScript source.
 * @param run Run collecting failures.
 * @returns How many sources were scanned.
 */
export function checkSharedSourceRules(run: BoundaryRun): number {
  const sourceFiles = walkFiles(
    run.packagesRoot,
    (name) => name.endsWith(".ts"),
    SKIPPED_DIRECTORIES,
  );
  if (sourceFiles.length === 0) {
    run.failures.push(
      "packages/: no TypeScript sources scanned; shared rules would pass vacuously",
    );
  }
  for (const file of sourceFiles) {
    checkSourceFile(run, file);
  }
  return sourceFiles.length;
}

/**
 * Fail any numbered layer notation in product non-documentation file paths or
 * non-documentation file text.
 * @param run Run collecting failures.
 * @returns How many non-documentation files were scanned.
 */
export function checkLayerVocabulary(run: BoundaryRun): number {
  let scanned = 0;
  for (const dir of FINAL_PACKAGE_DIRS) {
    const files = walkFiles(
      path.join(run.packagesRoot, dir),
      (name) => path.extname(name) !== ".md" && path.extname(name) !== ".mdx",
      new Set([...SKIPPED_DIRECTORIES, ".eslintcache"]),
    );
    if (files.length === 0) {
      run.failures.push(
        `packages/${dir}: no non-documentation files scanned; the vocabulary rule would pass vacuously here`,
      );
      continue;
    }
    scanned += files.length;
    for (const file of files) {
      checkLayerNotation(run, file);
    }
  }
  return scanned;
}

/**
 * Hold every product's imports to its final DAG, its dependencies' public
 * exports, and its own directory.
 * @param run Run collecting failures.
 * @returns How many product code files were scanned.
 */
export function checkFinalImports(run: BoundaryRun): number {
  let scanned = 0;
  for (const dir of FINAL_PACKAGE_DIRS) {
    const packageDirectory = path.join(run.packagesRoot, dir);
    const files = walkFiles(
      packageDirectory,
      (name) => CODE_EXTENSIONS.has(path.extname(name)),
      SKIPPED_DIRECTORIES,
    );
    if (files.length === 0) {
      run.failures.push(
        `packages/${dir}: no code files scanned; import rules would pass vacuously here`,
      );
      continue;
    }
    scanned += files.length;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      checkImports(run, { dir, packageDirectory, file, text });
    }
  }
  return scanned;
}

/**
 * Test infrastructure consumes public and condition-only entries without enabling
 * internal resolution. Configuration files are checked separately from code counts.
 * @param run Run collecting failures.
 * @returns How many integration code files were scanned.
 */
export function checkIntegrationImports(run: BoundaryRun): number {
  const root = path.join(run.repo, INTEGRATION_TESTS.root);
  checkIntegrationTree(run, root);
  const files = walkFiles(
    root,
    (name) => CODE_EXTENSIONS.has(path.extname(name)),
    SKIPPED_DIRECTORIES,
  );
  if (files.length === 0) {
    run.failures.push(
      `${INTEGRATION_TESTS.root}: no code files scanned; import rules would pass vacuously here`,
    );
  }
  const allowedRelative = new Set([
    path.join(run.repo, "scripts/test/packed-workspace.js"),
  ]);
  const eslintRelative = new Set([path.join(run.repo, "eslint.shared.js")]);
  for (const file of files) {
    checkIntegrationSourceFile(run, {
      file,
      text: readFileSync(file, "utf8"),
      allowedRelative,
      eslintRelative,
    });
  }
  checkIntegrationConfiguration(run, root);
  return files.length;
}

/** Manifest commands and compiler settings cannot hide internal resolution. */
function checkIntegrationConfiguration(run: BoundaryRun, root: string): void {
  for (const file of walkFiles(
    root,
    (name) => name === "package.json" || /^tsconfig.*\.json$/.test(name),
    SKIPPED_DIRECTORIES,
  )) {
    const text = readFileSync(file, "utf8");
    checkIntegrationInternalCondition(run, file, text);
    if (
      (path.basename(file) === "package.json" && /"imports"\s*:/.test(text)) ||
      (path.basename(file).startsWith("tsconfig") &&
        /"(?:paths|baseUrl)"\s*:/.test(text))
    ) {
      fail(
        run,
        file,
        1,
        "test infrastructure must not configure import resolution bypasses",
      );
    }
  }
}

/** One integration source and the exact shared modules it may resolve. */
interface IntegrationSourceSite {
  readonly file: string;
  readonly text: string;
  readonly allowedRelative: ReadonlySet<string>;
  readonly eslintRelative: ReadonlySet<string>;
}

/** Integration consumers cannot enable private resolution or reach product source. */
function checkIntegrationSourceFile(
  run: BoundaryRun,
  site: IntegrationSourceSite,
): void {
  const { file, text } = site;
  checkIntegrationInternalCondition(run, file, text);
  checkIntegrationLiteralImports(run, site);
  checkIntegrationResolverConfig(run, site);
  for (const input of importSpecifiers(text)) {
    checkIntegrationPath(run, site, input);
    if (
      packageRoot(input.specifier).startsWith("@moltzap/") &&
      !isIntegrationProductImport(input.specifier)
    ) {
      fail(
        run,
        file,
        lineAt(text, input.index),
        `test infrastructure must import public or test-only product exports from declared dependencies ("${input.specifier}")`,
      );
    }
  }
  for (const match of text.matchAll(
    /new\s+URL\(\s*["'`]([^"'`]+)["'`]\s*,\s*import\.meta\.url\s*(?:,\s*)?\)/g,
  )) {
    checkIntegrationPath(run, site, {
      specifier: match[1] ?? "",
      index: match.index,
      urlRelative: true,
    });
  }
  checkIntegrationDependencyPaths(run, site);
}

/** Internal conditions remain forbidden in source and command/configuration text. */
function checkIntegrationInternalCondition(
  run: BoundaryRun,
  file: string,
  text: string,
): void {
  const index = text.indexOf("sharness-internal");
  if (index !== -1) {
    fail(
      run,
      file,
      lineAt(text, index),
      "test infrastructure must not enable sharness-internal",
    );
  }
}

/** Computed module arguments would hide a product import from this source gate. */
function checkIntegrationLiteralImports(
  run: BoundaryRun,
  { file, text }: IntegrationSourceSite,
): void {
  for (const match of text.matchAll(/\b(?:import|require)\s*\(([^)]*)/g)) {
    const argument = match[1] ?? "";
    if (
      !/^\s*(["'`])[^"'`]*\1\s*(?:,|$)/.test(argument) ||
      /`[^`]*\$\{/.test(argument)
    ) {
      fail(
        run,
        file,
        lineAt(text, match.index),
        "test infrastructure imports must use string literals",
      );
    }
  }
}

/** Vitest aliases must not redirect an allowed package name to private source. */
function checkIntegrationResolverConfig(
  run: BoundaryRun,
  { file, text }: IntegrationSourceSite,
): void {
  if (
    /vitest[^/]*config\.[cm]?[jt]s$/.test(file) &&
    /["']?\balias["']?\s*(?:\]|:|[,}])|\bresolve\s*\.\s*alias\b/.test(text)
  ) {
    fail(
      run,
      file,
      1,
      "test infrastructure must not configure import resolution bypasses",
    );
  }
}

/** Binary paths must use dependencies installed for the integration workspace. */
function checkIntegrationDependencyPaths(
  run: BoundaryRun,
  { file, text }: IntegrationSourceSite,
): void {
  for (const match of text.matchAll(
    /["'`]([^"'`\n]*node_modules[^"'`\n]*)["'`]/g,
  )) {
    if (isForeignDependencyPath(run, file, match[1] ?? "")) {
      fail(
        run,
        file,
        lineAt(text, match.index),
        "test infrastructure must not use another workspace's node_modules",
      );
    }
  }
}

/** Root-relative workspace fragments also identify another workspace's dependency. */
function isForeignDependencyPath(
  run: BoundaryRun,
  file: string,
  specifier: string,
): boolean {
  const base = /^(?:packages|examples|tests)[/\\]/.test(specifier)
    ? run.repo
    : path.dirname(file);
  return (
    /(?:^|[/\\])node_modules(?:[/\\]|$)/.test(specifier) &&
    !path
      .resolve(base, specifier)
      .startsWith(path.join(run.repo, INTEGRATION_TESTS.root) + path.sep)
  );
}

/** File URLs and absolute paths obey the same containment rule as relative imports. */
function checkIntegrationPath(
  run: BoundaryRun,
  site: IntegrationSourceSite,
  input: ImportSpecifier,
): void {
  const { specifier, index } = input;
  const syntaxError = integrationSpecifierError(input);
  if (syntaxError !== undefined) {
    fail(run, site.file, lineAt(site.text, index), syntaxError);
    return;
  }
  if (!isIntegrationPathSpecifier(input)) {
    return;
  }
  const { file, text } = site;
  let resolved: string;
  try {
    resolved = resolveIntegrationPath(file, specifier);
  } catch (cause) {
    fail(
      run,
      file,
      lineAt(text, index),
      `test infrastructure must not cross its boundary by invalid or non-file URL ("${specifier}"): ${String(cause)}`,
    );
    return;
  }
  if (!isIntegrationPathAllowed(run, site, resolved)) {
    fail(
      run,
      file,
      lineAt(text, index),
      `test infrastructure must not cross its boundary by relative path ("${specifier}")`,
    );
  }
}

/** Escapes and URL suffixes must not change what the containment check resolves. */
function integrationSpecifierError(input: ImportSpecifier): string | undefined {
  if (input.specifier.includes("\\")) {
    return "test infrastructure must not use escaped import or URL specifiers";
  }
  return isIntegrationPathSpecifier(input) && /[?#%]/.test(input.specifier)
    ? "test infrastructure must not use query, fragment, or encoded path specifiers"
    : undefined;
}

/** Path references and URL schemes require containment; Node builtins resolve without files. */
function isIntegrationPathSpecifier(input: ImportSpecifier): boolean {
  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(input.specifier)?.[0];
  if (scheme?.toLowerCase() === "node:") {
    return false;
  }
  return (
    input.urlRelative === true ||
    input.specifier.startsWith(".") ||
    path.isAbsolute(input.specifier) ||
    scheme !== undefined
  );
}

/** Every specifier resolves as a URL reference relative to the containing file. */
function resolveIntegrationPath(file: string, specifier: string): string {
  return fileURLToPath(new URL(specifier, pathToFileURL(file)));
}

/** Shared ESLint modules are available only to the integration ESLint configuration. */
function isIntegrationPathAllowed(
  run: BoundaryRun,
  site: IntegrationSourceSite,
  resolved: string,
): boolean {
  return (
    resolved.startsWith(
      path.join(run.repo, INTEGRATION_TESTS.root) + path.sep,
    ) ||
    site.allowedRelative.has(resolved) ||
    (relativePath(run, site.file) === "tests/integration/eslint.config.ts" &&
      site.eslintRelative.has(resolved))
  );
}

function isIntegrationProductImport(specifier: string): boolean {
  const root = packageRoot(specifier);
  const dependencies: readonly PackageDir[] = INTEGRATION_TESTS.dependencies;
  const target = dependencies.find(
    (dir) => FINAL_PACKAGES[dir].npmName === root,
  );
  const entry =
    target === undefined
      ? undefined
      : FINAL_PACKAGES[target].exports[exportSubpath(specifier, root)];
  return entry !== undefined && entry.internalOnly !== true;
}

function checkSourceFile(run: BoundaryRun, file: string): void {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(
    /export\s+\*(?:\s+as\s+[^\s]+)?\s+from\s+["'][^"']+["']/g,
  )) {
    fail(
      run,
      file,
      lineAt(text, match.index),
      "wildcard export is not allowed",
    );
  }
  for (const match of text.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*["']#core["']/g,
  )) {
    if (CORE_SERVICE_TAGS.test(match[1] ?? "")) {
      fail(
        run,
        file,
        lineAt(text, match.index),
        "domain/socket/db service tags must import from their owning barrel, not #core",
      );
    }
  }
}

function checkLayerNotation(run: BoundaryRun, file: string): void {
  const relative = relativePath(run, file);
  if (new RegExp(LAYER_NOTATION_SOURCE).test(relative)) {
    run.failures.push(
      `${relative}: numbered architecture notation is documentation-only`,
    );
  }
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(new RegExp(LAYER_NOTATION_SOURCE, "g"))) {
    fail(
      run,
      file,
      lineAt(text, match.index),
      "numbered architecture notation is documentation-only; name the owning domain",
    );
  }
}

function checkImports(run: BoundaryRun, site: ImportSite): void {
  for (const { specifier, index } of importSpecifiers(site.text)) {
    const line = lineAt(site.text, index);
    const root = packageRoot(specifier);
    if (root.startsWith("@moltzap/")) {
      checkProductImport(run, site, specifier, line);
    }
    if (
      specifier.startsWith(".") &&
      !isInsidePackage(
        run,
        site,
        path.resolve(path.dirname(site.file), specifier),
      )
    ) {
      fail(
        run,
        site.file,
        line,
        `package must not cross its boundary by relative path ("${specifier}")`,
      );
    }
  }
}

function checkProductImport(
  run: BoundaryRun,
  site: ImportSite,
  specifier: string,
  line: number,
): void {
  const root = packageRoot(specifier);
  const target = FINAL_PACKAGE_DIRS.find(
    (dir) => FINAL_PACKAGES[dir].npmName === root,
  );
  if (target === undefined) {
    fail(run, site.file, line, `unknown workspace package import "${root}"`);
    return;
  }
  if (!mayImport(site, root)) {
    fail(
      run,
      site.file,
      line,
      `dependency DAG violation: "${site.dir}" may not import "${root}"`,
    );
    return;
  }
  checkProductEntry(run, site, { target, specifier, line });
}

function checkProductEntry(
  run: BoundaryRun,
  site: ImportSite,
  input: ProductEntrySite,
): void {
  const { target, specifier, line } = input;
  const root = FINAL_PACKAGES[target].npmName;
  const subpath = exportSubpath(specifier, root);
  checkTestOnlyImport(run, site, {
    testOnly: FINAL_PACKAGES[target].exports[subpath]?.testOnly,
    specifier,
    line,
  });
  if (!Object.hasOwn(FINAL_PACKAGES[target].exports, subpath)) {
    fail(
      run,
      site.file,
      line,
      `import "${specifier}" is not a public export of "${root}"`,
    );
  }
  checkInternalImport(run, site, input);
  if (
    isRuntimeAdapter(site.dir) &&
    root === "@moltzap/client" &&
    subpath !== "."
  ) {
    fail(
      run,
      site.file,
      line,
      "runtime adapter must import only the @moltzap/client root",
    );
  }
}

function checkInternalImport(
  run: BoundaryRun,
  site: ImportSite,
  input: ProductEntrySite,
): void {
  const { target, specifier, line } = input;
  const subpath = exportSubpath(specifier, FINAL_PACKAGES[target].npmName);
  if (
    FINAL_PACKAGES[target].exports[subpath]?.internalOnly === true &&
    site.dir !== "registry" &&
    site.dir !== "router"
  ) {
    fail(
      run,
      site.file,
      line,
      `internal Client capabilities are reserved for Registry and Router compositions ("${specifier}")`,
    );
  }
}

function mayImport(site: ImportSite, root: string): boolean {
  const contract = FINAL_PACKAGES[site.dir];
  return root === contract.npmName || dependencyNames(site.dir).includes(root);
}

function exportSubpath(specifier: string, root: string): string {
  return specifier === root ? "." : `.${specifier.slice(root.length)}`;
}

function isRuntimeAdapter(dir: PackageDir): boolean {
  return dir === "openclaw-channel" || dir === "nanoclaw-channel";
}

/**
 * Whether a resolved relative import stays inside its package, or names one
 * of the shared root configuration modules every package config loads.
 */
function isInsidePackage(
  run: BoundaryRun,
  site: ImportSite,
  resolved: string,
): boolean {
  return (
    sharedPackageConfigImports(run).has(resolved) ||
    resolved === site.packageDirectory ||
    resolved.startsWith(`${site.packageDirectory}${path.sep}`)
  );
}

/**
 * The resolved specifiers of the root modules package configurations share.
 * Package code imports them by their emitted `.js` name.
 */
function sharedPackageConfigImports(run: BoundaryRun): ReadonlySet<string> {
  return new Set([path.join(run.repo, "eslint.shared.js")]);
}

function importSpecifiers(text: string): readonly ImportSpecifier[] {
  return [
    ...text.matchAll(IMPORT_SPECIFIER),
    ...text.matchAll(RESOLVE_SPECIFIER),
  ]
    .filter((match) => match[1] !== "`" || !(match[2] ?? "").includes("${"))
    .map((match) => ({ specifier: match[2] ?? "", index: match.index }));
}

/** Test overrides may be imported by tests, __tests__ fixtures, and their own test-only entry source. */
function checkTestOnlyImport(
  run: BoundaryRun,
  site: ImportSite,
  input: {
    readonly testOnly?: true;
    readonly specifier: string;
    readonly line: number;
  },
): void {
  if (
    input.testOnly === true &&
    !isTestOnlyEntrySource(site) &&
    !site.file.endsWith(".test.ts") &&
    !path
      .relative(site.packageDirectory, site.file)
      .split(path.sep)
      .includes("__tests__")
  ) {
    fail(
      run,
      site.file,
      input.line,
      `production source must not import test-only export "${input.specifier}"`,
    );
  }
}

/** An entry may compose the test capabilities of its declared dependencies. */
function isTestOnlyEntrySource(site: ImportSite): boolean {
  return Object.values(FINAL_PACKAGES[site.dir].exports).some(
    (entry) =>
      entry.testOnly === true &&
      path.join(
        site.packageDirectory,
        entry.import.replace("./dist/", "src/").replace(/\.js$/, ".ts"),
      ) === site.file,
  );
}

/** The package a specifier addresses, ignoring any subpath export. */
function packageRoot(specifier: string): string {
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    return parts.length >= 2
      ? `${parts[0] ?? ""}/${parts[1] ?? ""}`
      : specifier;
  }
  return parts[0] ?? specifier;
}

/** Rejects symbolic links other than a `CLAUDE.md` pointing at its sibling `AGENTS.md`, and nested node_modules/dist directories; root installed dependencies are excluded. */
function checkIntegrationTree(run: BoundaryRun, directory: string): void {
  const installedDependencies = path.join(
    run.repo,
    INTEGRATION_TESTS.root,
    "node_modules",
  );
  const entries = readdirSync(directory, { withFileTypes: true }).filter(
    (entry) => path.join(directory, entry.name) !== installedDependencies,
  );
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink() && !isAgentInstructionsLink(file)) {
      fail(run, file, 1, "test infrastructure must not contain symbolic links");
    } else if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") {
        fail(
          run,
          file,
          1,
          "test infrastructure must not contain nested node_modules or dist directories",
        );
      }
      checkIntegrationTree(run, file);
    }
  }
}

/** Scoped agent instructions keep `CLAUDE.md` as a link to the `AGENTS.md` beside it. */
function isAgentInstructionsLink(file: string): boolean {
  return (
    path.basename(file) === "CLAUDE.md" && readlinkSync(file) === "AGENTS.md"
  );
}
