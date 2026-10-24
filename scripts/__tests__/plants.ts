/** @file Reversible file and symlink mutations, the assertion recorder, and the Node runner shared by standalone gate tests. */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** All gate children and reversible mutations share this repository root. */
export const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
/** The stack unwinds entries and snapshots in reverse mutation order. */
const planted: Array<{
  readonly path: string;
  readonly original?: Buffer;
  readonly directory?: true;
}> = [];

/** Prepend, replace the whole file, or replace a required substring; missing substring targets fail. */
export function plantBoundarySource(input: {
  readonly path: string;
  readonly prepend?: string;
  readonly replace?: string;
  readonly before?: string;
  readonly after?: string;
}): void {
  plantFile(input.path, (source) => {
    if (input.prepend !== undefined) {
      return input.prepend + source;
    }
    if (input.replace !== undefined) {
      return input.replace;
    }
    if (
      input.before === undefined ||
      input.after === undefined ||
      !source.includes(input.before)
    ) {
      throw new Error(`Mutation target missing in ${input.path}`);
    }
    return source.replace(input.before, input.after);
  });
}

/** Snapshots existing bytes, hands the mutator their UTF-8 text, and records a created file after its write succeeds. */
export function plantFile(
  relativePath: string,
  mutate: (source: string) => string | Uint8Array,
): void {
  const path = resolve(workspaceRoot, relativePath);
  const original = existsSync(path) ? readFileSync(path) : undefined;
  const source = mutate(original?.toString("utf8") ?? "");
  ensureParent(path);
  writeFileSync(path, source);
  planted.push(original === undefined ? { path } : { path, original });
}

/** Refuses existing entries, including dangling links, and records only a successfully created link. */
export function plantSymlink(relativePath: string, target: string): void {
  const path = resolve(workspaceRoot, relativePath);
  if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) {
    throw new Error(`Plant path already exists: ${relativePath}`);
  }
  ensureParent(path);
  symlinkSync(target, path);
  planted.push({ path });
}

/** Created entries tolerate prior removal; existing files recover their exact original bytes. */
export function restoreAllPlants(): void {
  for (const entry of planted.splice(0).reverse()) {
    if (entry.original === undefined) {
      rmSync(entry.path, {
        force: true,
        ...(entry.directory === true ? { recursive: true } : {}),
      });
    } else {
      writeFileSync(entry.path, entry.original);
    }
  }
}

interface AssertionFailure {
  readonly name: string;
  readonly message: string;
}

/** Assertions accumulate so one run reports every failed gate. */
export const failures: AssertionFailure[] = [];

/** Runs a Node gate with captured process feedback. */
export function runNode(
  args: readonly string[],
  cwd = workspaceRoot,
): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync(process.execPath, [...args], {
    cwd,
    encoding: "utf8",
  });
  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

/** Records each gate result and retains failures for the entry point. */
export function test(name: string, cond: boolean, message: string): void {
  // eslint-disable-next-line sonarjs/no-selector-parameter -- A boolean assertion selects the success or failure report in this standalone test runner.
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures.push({ name, message });
    console.error(`  ✗ ${name}: ${message}`);
  }
}

/** Missing parent directories belong to the plant and are removed after its file. */
function ensureParent(path: string): void {
  const parent = dirname(path);
  if (!existsSync(parent)) {
    ensureParent(parent);
    mkdirSync(parent);
    planted.push({ path: parent, directory: true });
  }
}
