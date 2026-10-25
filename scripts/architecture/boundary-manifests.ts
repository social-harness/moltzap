/**
 * @file Manifest and configuration rules of the architecture boundary check:
 * the wire compatibility literal, workspace roots, each product's manifest,
 * TypeScript references, declared targets, and Knip ignores, and the
 * published set the release workflow ships.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  HISTORY_WIRE_VERSIONS,
  LIVE_WIRE_VERSIONS,
  WIRE_VERSION_PATTERN,
} from "../../packages/identity/src/version.ts";
import {
  CALENDAR_VERSION,
  dependencyNames,
  exportCondition,
  type ExportTarget,
  FINAL_PACKAGE_DIRS,
  FINAL_PACKAGE_NAMES,
  FINAL_PACKAGES,
  INTEGRATION_TESTS,
  type PackageDir,
  REPOSITORY_URL,
} from "./boundary-contract.ts";
import {
  arrayAt,
  type BoundaryRun,
  failOnSetDrift,
  isJsonObject,
  type JsonObject,
  MalformedBoundaryInput,
  objectAt,
  readJsonObject,
  stringAt,
  stringsAt,
} from "./boundary-run.ts";

/** One product's manifest as the per-package rules read it. */
interface ProductManifest {
  readonly dir: PackageDir;
  /** Repository-relative manifest path used to identify diagnostics. */
  readonly where: string;
  readonly manifest: JsonObject;
}

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

const PRODUCTION_SECTIONS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];

/**
 * Identity owns emission and the live and retained wire sets. Every entry must
 * be a calendar version so servers advertise values that clients can decode;
 * package release versions remain independent. The sets come from the evaluated
 * version module; the emitted literal is read from its source text.
 * @param run Run collecting failures.
 * @returns The literal when it is a calendar version, otherwise null.
 */
export function checkCompatibilityVersion(run: BoundaryRun): string | null {
  const identitySource = path.join(run.packagesRoot, "identity", "src");
  const versionPath = path.join(identitySource, "version.ts");
  const compatibilityVersion = readCompatibilityVersion(run, versionPath);
  checkWireVersionSets(run);
  const identityIndex = path.join(identitySource, "index.ts");
  if (!existsSync(identityIndex)) {
    run.failures.push(
      "packages/identity/src/index.ts: missing; it exports the compatibility value",
    );
  } else if (
    !/export\s*\{[^}]*\bWIRE_VERSION\b[^}]*\}\s*from\s*["']\.\/version\.js["']/.test(
      readFileSync(identityIndex, "utf8"),
    )
  ) {
    run.failures.push(
      "packages/identity/src/index.ts: must re-export WIRE_VERSION from ./version.js",
    );
  }
  return compatibilityVersion;
}

/**
 * Pin the workspace roots that name the products: package names, Knip
 * workspaces, root project references, and the lint entry points.
 * @param run Run collecting failures.
 */
export function checkWorkspaceRoots(run: BoundaryRun): void {
  const knipWorkspaces = knipWorkspacesOf(run);
  failOnSetDrift(run, {
    where: "packages/*/package.json",
    what: "workspace package names drifted",
    actual: workspacePackageNames(run),
    wanted: FINAL_PACKAGE_NAMES,
  });
  failOnSetDrift(run, {
    where: "knip.json",
    what: "package workspace roots drifted",
    actual: Object.keys(knipWorkspaces).filter((name) =>
      name.startsWith("packages/"),
    ),
    wanted: FINAL_PACKAGE_DIRS.map((dir) => `packages/${dir}`),
  });
  failOnSetDrift(run, {
    where: "tsconfig.json",
    what: "root project references drifted",
    actual: referencePaths(
      readJsonObject(path.join(run.repo, "tsconfig.json")),
    ).map((referencePath) => path.normalize(referencePath)),
    wanted: [
      ...FINAL_PACKAGE_DIRS.map((dir) => path.join("packages", dir)),
      path.join("packages", "registry", "tsconfig.test-entry.json"),
    ],
  });
  checkLintEntryPoints(run);
}

/**
 * Test infrastructure consumes products without joining their graph or releases.
 * @param run Run collecting failures.
 */
export function checkIntegrationTests(run: BoundaryRun): void {
  const where = `${INTEGRATION_TESTS.root}/package.json`;
  const manifest = readJsonObject(path.join(run.repo, where));
  if (manifest.name !== INTEGRATION_TESTS.name || manifest.private !== true) {
    run.failures.push(
      `${where}: must name ${INTEGRATION_TESTS.name} and stay private`,
    );
  }
  failOnSetDrift(run, {
    where,
    what: "test infrastructure dependencies drifted",
    actual: [
      ...DEPENDENCY_SECTIONS.flatMap((section) =>
        Object.keys(objectAt(manifest, section)),
      ).filter((name) => name.startsWith("@moltzap/")),
      ...stringsAt(objectAt(manifest, "nx"), "implicitDependencies").map(
        (name) => `nx.implicitDependencies:${name}`,
      ),
    ],
    wanted: INTEGRATION_TESTS.dependencies.map(
      (dir) => FINAL_PACKAGES[dir].npmName,
    ),
  });
  checkDeclaredTargets(run, { where, manifest }, INTEGRATION_TESTS.root, {
    required: INTEGRATION_TESTS.targets,
  });
  failOnSetDrift(run, {
    where: "knip.json",
    what: "test workspace roots drifted",
    actual: Object.keys(knipWorkspacesOf(run)).filter((name) =>
      name.startsWith("tests/"),
    ),
    wanted: [INTEGRATION_TESTS.root],
  });
}

/**
 * Apply every per-product manifest, reference, target, and Knip rule.
 * @param run Run collecting failures.
 * @returns Manifest location to version, for every published product.
 */
export function checkProductManifests(
  run: BoundaryRun,
): ReadonlyMap<string, string> {
  const knipWorkspaces = knipWorkspacesOf(run);
  const publishedVersions = new Map<string, string>();
  for (const dir of FINAL_PACKAGE_DIRS) {
    const where = `packages/${dir}/package.json`;
    const product: ProductManifest = {
      dir,
      where,
      manifest: readJsonObject(
        path.join(run.packagesRoot, dir, "package.json"),
      ),
    };
    checkIdentity(run, product);
    checkNotices(run, product);
    const version = checkPublication(run, product);
    if (version !== undefined) {
      publishedVersions.set(where, version);
    }
    checkExports(run, product);
    checkBinaries(run, product);
    checkDependencies(run, product);
    checkReferences(run, dir);
    checkDeclaredTargets(run, product, `packages/${dir}`, {
      required: FINAL_PACKAGES[dir].targets,
      scriptTargets: Object.keys(objectAt(product.manifest, "scripts")),
    });
    checkKnipIgnores(run, product, objectAt(knipWorkspaces, `packages/${dir}`));
  }
  return publishedVersions;
}

/**
 * The release workflow must name the published set; otherwise a package
 * silently never releases. Each published package carries its own version.
 * @param run Run collecting failures.
 * @param publishedVersions Manifest location to version.
 */
export function checkReleaseSet(
  run: BoundaryRun,
  publishedVersions: ReadonlyMap<string, string>,
): void {
  if (publishedVersions.size === 0) {
    run.failures.push(
      "packages/*/package.json: no published package scanned; the release-set rule would pass vacuously",
    );
  }
  checkReleaseWorkflow(run);
}

/**
 * Release admission checks every advertised and retained version against the
 * same calendar shape as the emitted literal.
 */
function checkWireVersionSets(run: BoundaryRun): void {
  for (const [name, values] of Object.entries({
    LIVE_WIRE_VERSIONS,
    HISTORY_WIRE_VERSIONS,
  })) {
    for (const version of values.filter(
      (value) => !WIRE_VERSION_PATTERN.test(value),
    )) {
      run.failures.push(
        `packages/identity/src/version.ts: ${name} entry "${version}" is not a YYYY.MDD.N CalVer`,
      );
    }
  }
}

function readCompatibilityVersion(
  run: BoundaryRun,
  identityVersion: string,
): string | null {
  const literal = /export\s+const\s+WIRE_VERSION\s*=\s*["']([^"']*)["']/.exec(
    readFileSync(identityVersion, "utf8"),
  )?.[1];
  if (literal === undefined) {
    run.failures.push(
      "packages/identity/src/version.ts: must export the literal WIRE_VERSION",
    );
    return null;
  }
  if (!WIRE_VERSION_PATTERN.test(literal)) {
    run.failures.push(
      `packages/identity/src/version.ts: WIRE_VERSION "${literal}" is not a YYYY.MDD.N CalVer`,
    );
    return null;
  }
  return literal;
}

function knipWorkspacesOf(run: BoundaryRun): JsonObject {
  return objectAt(
    readJsonObject(path.join(run.repo, "knip.json")),
    "workspaces",
  );
}

function workspacePackageNames(run: BoundaryRun): ReadonlySet<string> {
  const names = new Set<string>();
  for (const dir of FINAL_PACKAGE_DIRS) {
    const manifestPath = path.join(run.packagesRoot, dir, "package.json");
    if (existsSync(manifestPath)) {
      names.add(String(stringAt(readJsonObject(manifestPath), "name")));
    }
  }
  return names;
}

function checkLintEntryPoints(run: BoundaryRun): void {
  const workspaceProject = readJsonObject(
    path.join(run.repo, "tools", "workspace", "project.json"),
  );
  const lintTarget = objectAt(objectAt(workspaceProject, "targets"), "lint");
  const dependencies = arrayAt(lintTarget, "dependsOn");
  for (const entry of dependencies) {
    if (
      typeof entry !== "string" &&
      (!isJsonObject(entry) || typeof entry.target !== "string")
    ) {
      throw new MalformedBoundaryInput({
        message:
          "Malformed dependsOn entry: expected a target string or object",
      });
    }
  }
  if (!dependencies.includes("lint:effect")) {
    run.failures.push(
      "tools/workspace/project.json: workspace:lint must depend on workspace:lint:effect",
    );
  }
  const rootManifest = readJsonObject(path.join(run.repo, "package.json"));
  if (
    stringAt(objectAt(rootManifest, "scripts"), "lint") !==
    "pnpm nx run workspace:lint"
  ) {
    run.failures.push(
      'package.json: lint must route through "pnpm nx run workspace:lint"',
    );
  }
}

function checkIdentity(
  run: BoundaryRun,
  { dir, where, manifest }: ProductManifest,
): void {
  const expected = FINAL_PACKAGES[dir].npmName;
  const name = manifest.name;
  if (name !== expected) {
    run.failures.push(
      `${where}: name is "${String(name)}", expected "${expected}"`,
    );
  }
  const project = readProject(run, `packages/${dir}`);
  if (project !== null && project.name !== expected) {
    run.failures.push(
      `packages/${dir}/project.json: name is "${String(project.name)}", expected "${expected}"`,
    );
  }
}

/**
 * Each tarball carries its own LICENSE and NOTICE because npm packs only the
 * package root; `pnpm pack` drops symlinks, so they are copies of the
 * repository files that must stay identical. Keyed on what the package ships
 * rather than on whether it publishes: a private package that redistributes
 * these files owes the same identity, and a package that ships neither owes
 * nothing.
 */
function checkNotices(
  run: BoundaryRun,
  { dir, manifest }: ProductManifest,
): void {
  const files = stringsAt(manifest, "files");
  for (const notice of ["LICENSE", "NOTICE"].filter((name) =>
    files.includes(name),
  )) {
    const packaged = path.join(run.packagesRoot, dir, notice);
    if (
      !existsSync(packaged) ||
      readFileSync(packaged, "utf8") !==
        readFileSync(path.join(run.packagesRoot, "..", notice), "utf8")
    ) {
      run.failures.push(
        `packages/${dir}/${notice}: must be an identical copy of the repository ${notice}`,
      );
    }
  }
}

/**
 * A published manifest goes to npm as written: no private flag, the one
 * license, the repository npm links provenance to, and a calendar version.
 * @returns The manifest version of a published product, otherwise undefined.
 */
function checkPublication(
  run: BoundaryRun,
  { dir, where, manifest }: ProductManifest,
): string | undefined {
  if (!FINAL_PACKAGES[dir].published) {
    if (manifest.private !== true) {
      run.failures.push(
        `${where}: must stay private; it is not in the published set`,
      );
    }
    return undefined;
  }
  if (manifest.private !== undefined) {
    run.failures.push(`${where}: a published package must not carry "private"`);
  }
  const license = stringAt(manifest, "license");
  if (license !== "Apache-2.0") {
    run.failures.push(
      `${where}: license is "${license ?? "missing"}", expected "Apache-2.0"`,
    );
  }
  if (stringAt(objectAt(manifest, "repository"), "url") !== REPOSITORY_URL) {
    run.failures.push(`${where}: repository.url must be "${REPOSITORY_URL}"`);
  }
  const version = String(stringAt(manifest, "version"));
  if (!CALENDAR_VERSION.test(version)) {
    run.failures.push(
      `${where}: version "${version}" is not a YYYY.MDD.N CalVer`,
    );
  }
  return version;
}

function checkExports(
  run: BoundaryRun,
  { dir, where, manifest }: ProductManifest,
): void {
  const wanted = FINAL_PACKAGES[dir].exports;
  const actualExports = objectAt(manifest, "exports");
  failOnSetDrift(run, {
    where,
    what: "exports drifted",
    actual: Object.keys(actualExports),
    wanted: Object.keys(wanted),
  });
  for (const [subpath, wantedTarget] of Object.entries(wanted)) {
    const actualTarget = resolvedExportTarget(
      run,
      objectAt(actualExports, subpath),
      {
        where,
        subpath,
        target: wantedTarget,
      },
    );
    for (const condition of ["types", "import"] as const) {
      const actual = stringAt(actualTarget, condition);
      if (actual !== wantedTarget[condition]) {
        run.failures.push(
          `${where}: export "${subpath}" ${condition} target is "${actual ?? "missing"}", expected "${wantedTarget[condition]}"`,
        );
      }
    }
  }
  const rootExport = wanted["."];
  if (
    rootExport !== undefined &&
    (manifest.main !== rootExport.import || manifest.types !== rootExport.types)
  ) {
    run.failures.push(
      `${where}: main/types must match the root export (${rootExport.import}, ${rootExport.types})`,
    );
  }
}

/** Test entries have no fallback condition that production resolution could select. */
function resolvedExportTarget(
  run: BoundaryRun,
  entry: JsonObject,
  site: {
    readonly where: string;
    readonly subpath: string;
    readonly target: ExportTarget;
  },
): JsonObject {
  const condition = exportCondition(site.target);
  if (condition === undefined) {
    return entry;
  }
  failOnSetDrift(run, {
    where: site.where,
    what: `test-only export "${site.subpath}" conditions drifted`,
    actual: Object.keys(entry),
    wanted: [condition],
  });
  return objectAt(entry, condition);
}

/**
 * Binaries are checked in rather than built, so the target exists at install
 * time and a declared binary is never a dangling link.
 */
function checkBinaries(
  run: BoundaryRun,
  { dir, where, manifest }: ProductManifest,
): void {
  const wanted = FINAL_PACKAGES[dir].bin;
  const actualBin = objectAt(manifest, "bin");
  failOnSetDrift(run, {
    where,
    what: "binaries drifted",
    actual: Object.keys(actualBin),
    wanted: Object.keys(wanted),
  });
  for (const [name, target] of Object.entries(wanted)) {
    const actual = stringAt(actualBin, name);
    const binPath = path.join(run.packagesRoot, dir, target);
    if (actual !== target) {
      run.failures.push(
        `${where}: binary "${name}" points at "${actual ?? "missing"}", expected "${target}"`,
      );
    } else if (existsSync(binPath)) {
      checkBinaryFile(run, where, name, binPath);
    } else {
      run.failures.push(
        `${where}: binary "${name}" points at missing file "${target}"`,
      );
    }
  }
}

function checkBinaryFile(
  run: BoundaryRun,
  where: string,
  name: string,
  binPath: string,
): void {
  if (!/^#!\/usr\/bin\/env node\r?\n/u.test(readFileSync(binPath, "utf8"))) {
    run.failures.push(`${where}: binary "${name}" lacks a node shebang`);
  }
  if ((statSync(binPath).mode & 0o111) === 0) {
    run.failures.push(`${where}: binary "${name}" is not executable`);
  }
}

/**
 * Sibling edges are `workspace:*`, which `pnpm pack` rewrites to the
 * sibling's exact manifest version, so a published package always pins its
 * siblings exactly.
 */
function checkDependencies(
  run: BoundaryRun,
  { dir, where, manifest }: ProductManifest,
): void {
  const wantedDeps = dependencyNames(dir);
  failOnSetDrift(run, {
    where,
    what: "production dependencies violate the final DAG",
    actual: new Set(
      PRODUCTION_SECTIONS.flatMap((section) =>
        Object.keys(objectAt(manifest, section)),
      ).filter((name) => name.startsWith("@moltzap/")),
    ),
    wanted: wantedDeps,
  });
  const dependencies = objectAt(manifest, "dependencies");
  for (const dependency of wantedDeps) {
    if (dependencies[dependency] !== "workspace:*") {
      run.failures.push(
        `${where}: final dependency "${dependency}" must be declared as "workspace:*"`,
      );
    }
  }
  for (const section of DEPENDENCY_SECTIONS) {
    const forbidden = Object.keys(objectAt(manifest, section)).filter(
      (name) => name.startsWith("@moltzap/") && !wantedDeps.includes(name),
    );
    for (const name of forbidden) {
      run.failures.push(
        `${where}: ${section} contains forbidden product edge "${name}"`,
      );
    }
  }
}

/**
 * Project references use normalized paths relative to packages/, so a path
 * that merely ends in an allowed directory name cannot escape the graph.
 */
function checkReferences(run: BoundaryRun, dir: PackageDir): void {
  const packageDirectory = path.join(run.packagesRoot, dir);
  const tsconfigPath = path.join(packageDirectory, "tsconfig.json");
  if (!existsSync(tsconfigPath)) {
    run.failures.push(`packages/${dir}/tsconfig.json: missing`);
    return;
  }
  failOnSetDrift(run, {
    where: `packages/${dir}/tsconfig.json`,
    what: "project references violate the final DAG",
    actual: referencePaths(readJsonObject(tsconfigPath)).map((referencePath) =>
      path.relative(
        run.packagesRoot,
        path.resolve(packageDirectory, referencePath),
      ),
    ),
    wanted: FINAL_PACKAGES[dir].deps,
  });
}

function checkDeclaredTargets(
  run: BoundaryRun,
  { where, manifest }: Pick<ProductManifest, "where" | "manifest">,
  projectRoot: string,
  {
    required,
    scriptTargets = [],
  }: {
    readonly required: readonly string[];
    readonly scriptTargets?: readonly string[];
  },
): void {
  const project = readProject(run, projectRoot) ?? {};
  const declaredTargets = new Set([
    ...scriptTargets,
    ...Object.keys(objectAt(objectAt(manifest, "nx"), "targets")),
    ...Object.keys(objectAt(project, "targets")),
  ]);
  const missing = required.filter((target) => !declaredTargets.has(target));
  if (missing.length > 0) {
    run.failures.push(
      `${where}: required Nx target declarations are missing: ${missing.join(", ")}`,
    );
  }
}

function readProject(run: BoundaryRun, projectRoot: string): JsonObject | null {
  const projectPath = path.join(run.repo, projectRoot, "project.json");
  return existsSync(projectPath) ? readJsonObject(projectPath) : null;
}

/**
 * Knip ignores describe dependencies reached outside its static TypeScript
 * graph, such as an executable launched by path. Source-visible imports need
 * no ignore, so only validate that every ignore is declared and that an
 * ignored product package belongs to the final DAG.
 */
function checkKnipIgnores(
  run: BoundaryRun,
  { dir, where, manifest }: ProductManifest,
  knipWorkspace: JsonObject,
): void {
  const ignored = stringsAt(knipWorkspace, "ignoreDependencies");
  const declared = new Set(
    DEPENDENCY_SECTIONS.flatMap((section) =>
      Object.keys(objectAt(manifest, section)),
    ),
  );
  const undeclared = ignored.filter((name) => !declared.has(name));
  if (undeclared.length > 0) {
    run.failures.push(
      `knip.json workspaces["packages/${dir}"]: ignored dependencies are not declared by ${where}: ${undeclared.join(", ")}`,
    );
  }
  const wantedDeps = dependencyNames(dir);
  const disallowed = ignored.filter(
    (name) => name.startsWith("@moltzap/") && !wantedDeps.includes(name),
  );
  if (disallowed.length > 0) {
    run.failures.push(
      `knip.json workspaces["packages/${dir}"]: ignored product dependencies violate the final DAG: ${disallowed.join(", ")}`,
    );
  }
}

/**
 * The release workflow carries its own list of the packages it publishes;
 * the two must name the same set or a package silently never releases.
 */
function checkReleaseWorkflow(run: BoundaryRun): void {
  const releaseWorkflow = readFileSync(
    path.join(run.repo, ".github", "workflows", "publish.yml"),
    "utf8",
  );
  const releasePackages = releaseWorkflow
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("RELEASE_PACKAGES:"))
    ?.slice("RELEASE_PACKAGES:".length)
    .trim();
  if (releasePackages === undefined || releasePackages === "") {
    run.failures.push(
      ".github/workflows/publish.yml: no RELEASE_PACKAGES line",
    );
    return;
  }
  failOnSetDrift(run, {
    where: ".github/workflows/publish.yml",
    what: "RELEASE_PACKAGES drifted from the published set",
    actual: releasePackages.trim().split(/\s+/),
    wanted: FINAL_PACKAGE_DIRS.filter((dir) => FINAL_PACKAGES[dir].published),
  });
}

function referencePaths(tsconfig: JsonObject): readonly string[] {
  return arrayAt(tsconfig, "references").map((reference) => {
    if (!isJsonObject(reference) || typeof reference.path !== "string") {
      throw new MalformedBoundaryInput({
        message:
          "Malformed references entry: expected an object with a string path",
      });
    }
    return reference.path;
  });
}
