/**
 * @file Checks documented Mermaid diagrams with the Mermaid CLI.
 * `pnpm docs:check:mermaid` fails on invalid diagrams or unreadable inputs.
 */
import { type CommandExecutor, FileSystem, Path } from "@effect/platform";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectBlocks,
  collectDiagramFiles,
  lintBlock,
  MERMAID_ROOTS,
  type MermaidBlock,
  type MermaidFailure,
  type MermaidGateError,
  requireRoots,
} from "./mermaid-lint.ts";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(SCRIPT_DIR, "..", "..");
const TEMP_DIR = resolve(
  WORKSPACE_ROOT,
  "node_modules",
  ".cache",
  "mermaid-lint",
);

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const roots = MERMAID_ROOTS.map((r) => resolve(WORKSPACE_ROOT, r));
  yield* requireRoots(fs, roots);
  const files = yield* collectDiagramFiles(fs, path, roots);
  const blocks = yield* collectBlocks(fs, path, WORKSPACE_ROOT, files);
  yield* announce(blocks.length, files.length);
  const failures = yield* lintAll(blocks);
  yield* report(failures);
}).pipe(Effect.catchTag("MermaidGateError", reportUninspectable));

function announce(blocks: number, files: number): Effect.Effect<void> {
  return Effect.sync(() =>
    process.stdout.write(
      `Checking ${blocks} Mermaid block(s) across ${files} file(s)...\n`,
    ),
  );
}

function lintAll(
  blocks: readonly MermaidBlock[],
): Effect.Effect<
  readonly MermaidFailure[],
  MermaidGateError,
  FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor
> {
  return Effect.gen(function* () {
    const results = yield* Effect.forEach(
      blocks,
      (block) => lintBlock(block, TEMP_DIR),
      { concurrency: 4 },
    );
    return results.filter((r): r is MermaidFailure => r !== null);
  });
}

function report(failures: readonly MermaidFailure[]): Effect.Effect<void> {
  return Effect.sync(() => {
    if (failures.length === 0) {
      process.stdout.write("Mermaid lint: PASS\n");
      return;
    }
    for (const f of failures) {
      process.stderr.write(
        `${f.block.file}:${f.block.startLine} — ${f.message}\n`,
      );
    }
    process.stderr.write(`Mermaid lint: FAIL (${failures.length})\n`);
    process.exit(1);
  });
}

/**
 * An input the run could not inspect is reported as its own outcome, never
 * folded into the block tally: "0 failures" would claim the input was
 * checked and clean.
 */
function reportUninspectable(error: MermaidGateError): Effect.Effect<never> {
  return Effect.sync(() => {
    process.stderr.write(`Mermaid lint: ${error.reason}: ${error.path}\n`);
    process.stderr.write(`    ${String(error.cause)}\n`);
    process.stderr.write("Mermaid lint: FAIL (inputs left unchecked)\n");
    process.exit(1);
  });
}

NodeRuntime.runMain(program.pipe(Effect.provide(NodeContext.layer)));
