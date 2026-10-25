#!/usr/bin/env node
/**
 * @file Dependency-version gate. Each dependency version has one source, and
 * every literal copy a tool needs must agree with it:
 *
 * - npm ranges live in the `pnpm-workspace.yaml` catalog. Workspace manifests
 *   declare `catalog:` or `workspace:*`; a `>=` peer range is a support floor
 *   of its own that the catalog pin must satisfy; every catalog entry has a
 *   consumer; the example, installed from npm outside the workspace, copies
 *   the catalog ranges.
 * - The forced Effect version is the `effect` override; the Effect source
 *   checkout script copies it as a tag.
 * - The supported Node.js range is the root `engines.node`; published
 *   manifests and the example copy it because npm reads `engines` from the
 *   tarball alone, and the `.node-version` pin must satisfy it.
 * - A GitHub Action is used at one ref across every workflow and composite
 *   action.
 *
 * Run from the repository root. Exits 1 with every disagreement listed.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import {
  FINAL_PACKAGE_DIRS,
  FINAL_PACKAGES,
  INTEGRATION_TESTS,
} from "../architecture/boundary-contract.ts";
import {
  isJsonObject,
  type JsonObject,
  objectAt,
  readJsonObject,
  stringAt,
} from "../architecture/boundary-run.ts";

const INSTALLED_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
];

const EFFECT_SCRIPT = "scripts/setup/prepare-effect.sh";

const repo = process.cwd();
const failures: string[] = [];

/** One package manifest and the repository-relative path failures name. */
interface Manifest {
  readonly where: string;
  readonly manifest: JsonObject;
}

/** One declared dependency of one manifest. */
interface Declaration {
  readonly where: string;
  readonly section: string;
  readonly name: string;
  readonly value: unknown;
}

/** One remote `uses:` line of a workflow or composite action. */
interface ActionUse {
  readonly where: string;
  readonly action: string;
  readonly ref: string;
}

type Version = readonly [number, number, number];

/**
 * Comparator operators, longest first so `>=` is not read as `>`; the empty
 * operator means equality.
 */
const OPERATORS: ReadonlyArray<readonly [string, (order: number) => boolean]> =
  [
    [">=", (order) => order >= 0],
    ["<=", (order) => order <= 0],
    [">", (order) => order > 0],
    ["<", (order) => order < 0],
    ["=", (order) => order === 0],
    ["", (order) => order === 0],
  ];

/** One semver comparator: an operator followed by a version. */
interface Comparator {
  readonly holds: (version: Version) => boolean;
}

function main(): void {
  const workspace = readWorkspace();
  const catalog = stringRecord(workspace, "catalog");
  const overrides = stringRecord(workspace, "overrides");
  const root = manifestAt("package.json");
  const workspaceManifests = [
    root,
    ...FINAL_PACKAGE_DIRS.map((dir) =>
      manifestAt(`packages/${dir}/package.json`),
    ),
    manifestAt(`${INTEGRATION_TESTS.root}/package.json`),
  ];
  const examples = exampleManifests();

  const consumed = checkInstalledSpecifiers(workspaceManifests);
  checkCatalogConsumers(catalog, overrides, consumed);
  checkPeerFloors(workspaceManifests, catalog);
  checkExampleCopies(examples, catalog);
  checkEffectCheckout(overrides);
  checkNodeRange(root, examples);
  const actionUses = readActionUses();
  checkActionRefs(actionUses);

  if (failures.length > 0) {
    console.error("[check-dependency-versions] FAIL");
    for (const failure of failures) {
      console.error(`  ${failure}`);
    }
    process.exit(1);
  }
  console.log(
    `[check-dependency-versions] OK — ${Object.keys(catalog).length} catalog entries, ${workspaceManifests.length} workspace and ${examples.length} example manifests, ${actionUses.length} action uses`,
  );
}

function readWorkspace(): JsonObject {
  const value: unknown = parse(
    readFileSync(path.join(repo, "pnpm-workspace.yaml"), "utf8"),
  );
  if (!isJsonObject(value)) {
    failures.push("pnpm-workspace.yaml: expected a mapping");
    return {};
  }
  return value;
}

function stringRecord(
  source: JsonObject,
  key: string,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(objectAt(source, key))) {
    if (typeof value === "string") {
      out[name] = value;
    } else {
      failures.push(`pnpm-workspace.yaml: ${key}.${name} must be a string`);
    }
  }
  return out;
}

function manifestAt(where: string): Manifest {
  return { where, manifest: readJsonObject(path.join(repo, where)) };
}

function exampleManifests(): readonly Manifest[] {
  return readdirIfPresent(path.join(repo, "examples"))
    .filter((name) =>
      existsSync(path.join(repo, "examples", name, "package.json")),
    )
    .map((name) => manifestAt(`examples/${name}/package.json`));
}

/**
 * A workspace manifest names no npm version itself.
 * @param manifests Root and package manifests.
 * @returns The names declared through `catalog:`.
 */
function checkInstalledSpecifiers(
  manifests: readonly Manifest[],
): ReadonlySet<string> {
  const declarations = manifests.flatMap((manifest) =>
    declarationsOf(manifest, INSTALLED_SECTIONS),
  );
  for (const { where, section, name, value } of declarations) {
    if (value !== "catalog:" && value !== "workspace:*") {
      failures.push(
        `${where}: ${section}.${name} is ${JSON.stringify(value)}; declare "catalog:" and set the range in the pnpm-workspace.yaml catalog`,
      );
    }
  }
  return new Set(
    declarations
      .filter((declaration) => declaration.value === "catalog:")
      .map((declaration) => declaration.name),
  );
}

/**
 * The catalog holds no entry that no manifest or override consumes.
 * @param catalog Catalog name to range.
 * @param overrides Override selector to version or `catalog:`.
 * @param consumed Names manifests declare through `catalog:`.
 */
function checkCatalogConsumers(
  catalog: Readonly<Record<string, string>>,
  overrides: Readonly<Record<string, string>>,
  consumed: ReadonlySet<string>,
): void {
  const overridden = Object.entries(overrides)
    .filter(([, value]) => value === "catalog:")
    .map(([selector]) => selector.split(">").at(-1) ?? selector);
  const used = new Set([...consumed, ...overridden]);
  for (const name of Object.keys(catalog).filter((key) => !used.has(key))) {
    failures.push(
      `pnpm-workspace.yaml: catalog.${name} has no consumer; remove it`,
    );
  }
}

/**
 * A peer range is a support floor set in its manifest; the catalog pin the
 * package is tested against must satisfy it.
 * @param manifests Root and package manifests.
 * @param catalog Catalog name to range.
 */
function checkPeerFloors(
  manifests: readonly Manifest[],
  catalog: Readonly<Record<string, string>>,
): void {
  const peers = manifests.flatMap((manifest) =>
    declarationsOf(manifest, ["peerDependencies"]),
  );
  for (const { where, name, value } of peers) {
    const floor =
      typeof value === "string" ? parseComparator(value) : undefined;
    const pin = parseVersion(catalog[name] ?? "");
    if (floor === undefined || pin === undefined || !floor.holds(pin)) {
      failures.push(
        `${where}: peerDependencies.${name} is ${JSON.stringify(value)}; the catalog pin ${catalog[name] ?? "(missing)"} must be an exact version inside it`,
      );
    }
  }
}

/**
 * The example installs from npm, so it copies each catalog range literally;
 * its Social Harness pins are the release version the release workflow writes.
 * @param examples Example manifests.
 * @param catalog Catalog name to range.
 */
function checkExampleCopies(
  examples: readonly Manifest[],
  catalog: Readonly<Record<string, string>>,
): void {
  const copies = examples
    .flatMap((example) => declarationsOf(example, INSTALLED_SECTIONS))
    .filter((declaration) => !declaration.name.startsWith("@moltzap/"));
  for (const { where, section, name, value } of copies) {
    if (value !== catalog[name]) {
      failures.push(
        `${where}: ${section}.${name} is ${JSON.stringify(value)}, expected the catalog range ${JSON.stringify(catalog[name] ?? "missing")}`,
      );
    }
  }
}

function declarationsOf(
  manifest: Manifest,
  sections: readonly string[],
): readonly Declaration[] {
  return sections.flatMap((section) =>
    Object.entries(objectAt(manifest.manifest, section)).map(
      ([name, value]) => ({ where: manifest.where, section, name, value }),
    ),
  );
}

function checkEffectCheckout(
  overrides: Readonly<Record<string, string>>,
): void {
  const tag = /^tag="effect@([^"]+)"$/m.exec(
    readFileSync(path.join(repo, EFFECT_SCRIPT), "utf8"),
  )?.[1];
  if (tag !== overrides.effect) {
    failures.push(
      `${EFFECT_SCRIPT}: clones effect@${tag ?? "missing"}, expected the pnpm-workspace.yaml override effect@${overrides.effect ?? "missing"}; update tag and expected together`,
    );
  }
}

function checkNodeRange(root: Manifest, examples: readonly Manifest[]): void {
  const nodeRange = stringAt(objectAt(root.manifest, "engines"), "node");
  if (nodeRange === undefined) {
    failures.push(
      "package.json: engines.node is missing; it is the supported Node.js range",
    );
    return;
  }
  checkEngineCopies(nodeRange, examples);
  checkNodePin(nodeRange);
}

/**
 * Published manifests and examples must carry the root range; any other
 * package manifest that declares one must match it.
 * @param nodeRange Root `engines.node`.
 * @param examples Example manifests.
 */
function checkEngineCopies(
  nodeRange: string,
  examples: readonly Manifest[],
): void {
  const copies = [
    ...FINAL_PACKAGE_DIRS.map((dir) => ({
      required: FINAL_PACKAGES[dir].published,
      ...manifestAt(`packages/${dir}/package.json`),
    })),
    ...examples.map((example) => ({ required: true, ...example })),
  ];
  for (const { where, manifest, required } of copies) {
    const node = stringAt(objectAt(manifest, "engines"), "node");
    if ((required || node !== undefined) && node !== nodeRange) {
      failures.push(
        `${where}: engines.node is "${node ?? "missing"}", expected the root package.json range "${nodeRange}"`,
      );
    }
  }
}

function checkNodePin(nodeRange: string): void {
  const pin = readFileSync(path.join(repo, ".node-version"), "utf8").trim();
  const version = parseVersion(pin);
  const comparators = nodeRange.split(/\s+/).map(parseComparator);
  if (version === undefined || comparators.includes(undefined)) {
    failures.push(
      `.node-version "${pin}" or engines.node "${nodeRange}" is not a version and a space-separated comparator list`,
    );
    return;
  }
  if (!comparators.every((c) => c?.holds(version) === true)) {
    failures.push(
      `.node-version: ${pin} is outside the root engines.node range "${nodeRange}"`,
    );
  }
}

function parseComparator(text: string): Comparator | undefined {
  const entry = OPERATORS.find(([operator]) => text.startsWith(operator));
  const bound = parseVersion(text.slice(entry?.[0].length ?? 0));
  if (entry === undefined || bound === undefined) {
    return undefined;
  }
  const [, accepts] = entry;
  return { holds: (version) => accepts(compareVersions(version, bound)) };
}

function compareVersions(left: Version, right: Version): number {
  const index = left.findIndex((part, i) => part !== right[i]);
  return index === -1 ? 0 : (left[index] ?? 0) - (right[index] ?? 0);
}

function parseVersion(text: string): Version | undefined {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(text);
  if (match === null) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/**
 * Every remote `uses:` line of the workflows and composite actions.
 * @returns One entry per line; local `./` actions are skipped.
 */
function readActionUses(): readonly ActionUse[] {
  const github = path.join(repo, ".github");
  const files = [
    ...readdirIfPresent(path.join(github, "workflows"))
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .map((name) => path.join(github, "workflows", name)),
    ...readdirIfPresent(path.join(github, "actions"))
      .map((name) => path.join(github, "actions", name, "action.yml"))
      .filter((file) => existsSync(file)),
  ];
  return files.flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .map((line) => actionUseOf(line, path.relative(repo, file)))
      .filter((use) => use !== undefined),
  );
}

function actionUseOf(line: string, where: string): ActionUse | undefined {
  const trimmed = line.trim().replace(/^- /, "").trim();
  if (!trimmed.startsWith("uses:")) {
    return undefined;
  }
  const target = trimmed.slice("uses:".length).trim().split(" ")[0] ?? "";
  const at = target.lastIndexOf("@");
  return at <= 0
    ? undefined
    : { where, action: target.slice(0, at), ref: target.slice(at + 1) };
}

/**
 * One action is used at one ref everywhere, so a bump edits every use.
 * @param uses Remote action uses.
 */
function checkActionRefs(uses: readonly ActionUse[]): void {
  for (const action of new Set(uses.map((use) => use.action))) {
    const sameAction = uses.filter((use) => use.action === action);
    const refs = [...new Set(sameAction.map((use) => use.ref))];
    if (refs.length > 1) {
      const listed = refs.map(
        (ref) =>
          `${ref} (${sameAction
            .filter((use) => use.ref === ref)
            .map((use) => use.where)
            .join(", ")})`,
      );
      failures.push(
        `${action}: used at ${refs.length} refs: ${listed.join("; ")}; use one ref`,
      );
    }
  }
}

function readdirIfPresent(dir: string): readonly string[] {
  return existsSync(dir)
    ? readdirSync(dir).sort((left, right) => left.localeCompare(right))
    : [];
}

main();
