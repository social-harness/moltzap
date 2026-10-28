/**
 * @file Collect workspace fenced ```mermaid blocks under the trees named by
 * `MERMAID_ROOTS` and validate each by piping it through `mmdc` (the
 * official Mermaid CLI). Returns the list of failures grouped by file.
 */
import {
  Command,
  type CommandExecutor,
  FileSystem,
  Path,
} from "@effect/platform";
import { Data, Effect, Either, Stream, String as StringOps } from "effect";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Workspace-relative trees the gate walks. Every documented tree must be
 * listed here: a tree left out is not reported as skipped, it simply
 * contributes zero blocks and the gate passes without having looked.
 */
export const MERMAID_ROOTS = ["docs", "packages", "plugins"] as const;

/**
 * Something the gate was asked to inspect but could not.
 *
 * Every filesystem step here answers "what am I checking?", so a failure
 * means some input went unchecked. Substituting an empty default — no
 * entries, no source text, no temp file — makes that indistinguishable
 * from a clean result, which is precisely the blind-gate failure this
 * gate exists to catch. The path travels with the error because a run
 * that cannot say which input it skipped has not reported anything.
 */
export class MermaidGateError extends Data.TaggedError("MermaidGateError")<{
  readonly reason: string;
  readonly path: string;
  readonly cause: unknown;
}> {}

/** Describes mermaid block. */
export interface MermaidBlock {
  readonly file: string;
  readonly startLine: number;
  readonly body: string;
}

/** Describes mermaid failure. */
export interface MermaidFailure {
  readonly block: MermaidBlock;
  readonly message: string;
}

/** Directories that never hold reviewable documentation. */
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

interface WalkCtx {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly out: string[];
}

interface ExtractorState {
  inFence: boolean;
  fenceLang: string | null;
  blockStart: number;
  bodyLines: string[];
  out: MermaidBlock[];
}

const MMDC_BIN = "mmdc";

/**
 * Chrome launch flags for the renderer. `mmdc` merges this file into its
 * `puppeteer.launch()` options.
 */
const PUPPETEER_CONFIG = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "mermaid-puppeteer.json",
);

/** Lines of mmdc stderr kept in a failure message; the rest is stack noise. */
const STDERR_LINES_KEPT = 6;

interface MmdcRun {
  readonly exitCode: number;
  readonly stderr: string;
}

/**
 * Reject any configured root that is not a usable directory. A root that
 * is missing, unreadable, or a plain file contributes no files, so without
 * this the run would report a clean pass over a tree it never opened.
 * Roots are checked sequentially so the first failure follows the declared input order.
 */
export function requireRoots(
  fs: FileSystem.FileSystem,
  roots: readonly string[],
): Effect.Effect<void, MermaidGateError> {
  return Effect.forEach(
    roots,
    (root) =>
      fs.stat(root).pipe(
        Effect.mapError(gateError("cannot open configured root", root)),
        Effect.flatMap((info) =>
          info.type === "Directory"
            ? Effect.void
            : Effect.fail(
                new MermaidGateError({
                  reason: "configured root is not a directory",
                  path: root,
                  cause: info.type,
                }),
              ),
        ),
      ),
    { discard: true, concurrency: 1 },
  );
}

/**
 * Markdown files below `roots` and TypeScript under `packages/`, sorted for stable output.
 */
export function collectDiagramFiles(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  roots: readonly string[],
): Effect.Effect<readonly string[], MermaidGateError> {
  return Effect.gen(function* () {
    const ctx: WalkCtx = { fs, path, out: [] };
    for (const root of roots) {
      yield* walkInto(ctx, root);
    }
    return ctx.out.sort((left, right) => StringOps.localeCompare(right)(left));
  }).pipe(Effect.withSpan("collectDiagramFiles"));
}

/**
 * Extract every fenced block from `files`, labelled relative to the root.
 */
export function collectBlocks(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workspaceRoot: string,
  files: readonly string[],
): Effect.Effect<readonly MermaidBlock[], MermaidGateError> {
  return Effect.gen(function* () {
    const out: MermaidBlock[] = [];
    for (const file of files) {
      const source = yield* fs
        .readFileString(file)
        .pipe(Effect.mapError(gateError("cannot read file", file)));
      out.push(
        ...extractMermaidBlocks(path.relative(workspaceRoot, file), source),
      );
    }
    return out;
  }).pipe(Effect.withSpan("collectBlocks"));
}

/**
 * Locate every fenced `mermaid` block in the given file. Returns the
 * block's 1-based start line (the opening fence) and raw body text.
 * Skips blocks whose fence is preceded by 4+ spaces (markdown
 * indented-code) and blocks fenced in a different language.
 */
export function extractMermaidBlocks(
  file: string,
  source: string,
): readonly MermaidBlock[] {
  if (file.endsWith(".ts")) {
    return [...source.matchAll(/\/\*\*[\s\S]*?\*\//gu)].flatMap((match) => {
      const startLine = source.slice(0, match.index).split("\n").length - 1;
      const body = match[0].replace(/^[ \t]*\* ?/gmu, "");
      return extractFencedBlocks(file, body, startLine);
    });
  }
  return extractFencedBlocks(file, source);
}

/**
 * Validate `block.body` by writing it to a temp file and shelling out
 * to `mmdc`. Returns null on success or a `MermaidFailure` carrying
 * mmdc's exit context on failure.
 */
export function lintBlock(
  block: MermaidBlock,
  tempDir: string,
): Effect.Effect<
  MermaidFailure | null,
  MermaidGateError,
  FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const slug = `${block.file.replace(/[^a-zA-Z0-9]/g, "_")}-${block.startLine}`;
    const inputPath = path.resolve(tempDir, `${slug}.mmd`);
    const outputPath = path.resolve(tempDir, `${slug}.svg`);
    yield* prepareInput(fs, tempDir, inputPath, block.body);
    const result = yield* runMmdc(inputPath, outputPath);
    yield* cleanup(fs, inputPath, outputPath);
    return interpretResult(block, result);
  }).pipe(Effect.withSpan("lintBlock"));
}

function extractFencedBlocks(
  file: string,
  source: string,
  startLine = 0,
): readonly MermaidBlock[] {
  const lines = StringOps.split(source, "\n");
  const state: ExtractorState = {
    inFence: false,
    fenceLang: null,
    blockStart: -1,
    bodyLines: [],
    out: [],
  };
  for (let i = 0; i < lines.length; i++) {
    processLine(file, lines[i] ?? "", i + startLine, state);
  }
  return state.out;
}

function processLine(
  file: string,
  line: string,
  lineIx: number,
  state: ExtractorState,
): void {
  const fenceMatch = /^([ \t]*)(```+|~~~+)([A-Za-z0-9_-]*)\s*$/.exec(line);
  if (fenceMatch) {
    handleFence(file, fenceMatch, lineIx, state);
    return;
  }
  if (state.inFence && state.fenceLang === "mermaid") {
    state.bodyLines.push(line);
  }
}

function handleFence(
  file: string,
  match: RegExpMatchArray,
  lineIx: number,
  state: ExtractorState,
): void {
  const indent = match[1] ?? "";
  const lang = match[3] ?? "";
  if (!state.inFence) {
    if (StringOps.length(indent) >= 4) {
      return;
    }
    state.inFence = true;
    state.fenceLang = lang || null;
    state.blockStart = lineIx + 1;
    state.bodyLines = [];
    return;
  }
  if (state.fenceLang === "mermaid") {
    state.out.push({
      file,
      startLine: state.blockStart,
      body: state.bodyLines.join("\n"),
    });
  }
  state.inFence = false;
  state.fenceLang = null;
}

/**
 * Stage one block for `mmdc`. The temp path is derived from the block's
 * file and line, so a discarded write error would leave whatever the last
 * run put there and `mmdc` would happily validate that instead — passing
 * the block that was never written.
 */
function prepareInput(
  fs: FileSystem.FileSystem,
  tempDir: string,
  inputPath: string,
  body: string,
): Effect.Effect<void, MermaidGateError> {
  return Effect.gen(function* () {
    yield* fs
      .makeDirectory(tempDir, { recursive: true })
      .pipe(
        Effect.mapError(gateError("cannot create temp directory", tempDir)),
      );
    yield* fs
      .writeFileString(inputPath, body)
      .pipe(Effect.mapError(gateError("cannot write temp input", inputPath)));
  });
}

/**
 * Run one block through `mmdc`, keeping its stderr. Mmdc reports both
 * diagram syntax errors and browser launch failures there, and the exit
 * code alone cannot tell those apart.
 * Stdout remains inherited while stderr is drained; an undrained stdout pipe can block the renderer.
 */
function runMmdc(
  inputPath: string,
  outputPath: string,
): Effect.Effect<
  Either.Either<MmdcRun, unknown>,
  never,
  CommandExecutor.CommandExecutor
> {
  return Effect.scoped(
    Effect.gen(function* () {
      const proc = yield* Command.make(
        MMDC_BIN,
        "--input",
        inputPath,
        "--output",
        outputPath,
        "--puppeteerConfigFile",
        PUPPETEER_CONFIG,
        "--quiet",
      ).pipe(Command.stdout("inherit"), Command.stderr("pipe"), Command.start);
      const stderr = yield* proc.stderr.pipe(
        Stream.decodeText(),
        Stream.mkString,
      );
      const exitCode = yield* proc.exitCode;
      return { exitCode, stderr } satisfies MmdcRun;
    }),
  ).pipe(Effect.either);
}

/**
 * Best-effort, unlike the write above: a block that fails to parse leaves
 * no SVG behind, so removing it is expected to fail and says nothing about
 * whether the block was checked. Leftovers cannot mask a bad block either,
 * since every run fails outright if it cannot overwrite its input.
 */
function cleanup(
  fs: FileSystem.FileSystem,
  inputPath: string,
  outputPath: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* fs.remove(inputPath).pipe(Effect.catchAll(() => Effect.void));
    yield* fs.remove(outputPath).pipe(Effect.catchAll(() => Effect.void));
  });
}

function interpretResult(
  block: MermaidBlock,
  result: Either.Either<MmdcRun, unknown>,
): MermaidFailure | null {
  return Either.match(result, {
    onLeft: (e) => ({ block, message: `mmdc launch failed: ${String(e)}` }),
    onRight: (run) =>
      run.exitCode === 0
        ? null
        : {
            block,
            message: `mmdc exited ${String(run.exitCode)}${formatStderr(run.stderr)}`,
          },
  });
}

/**
 * Indent the leading lines of mmdc stderr under the failure's header.
 * Stack frames are dropped: a browser launch failure buries its one useful
 * line under a deep trace, and that trace repeats for every block.
 */
function formatStderr(stderr: string): string {
  const lines = StringOps.split(stderr, "\n")
    .map(StringOps.trimEnd)
    .filter((line) => StringOps.isNonEmpty(line) && !/^\s*at\s/.test(line))
    .slice(0, STDERR_LINES_KEPT);
  if (lines.length === 0) {
    return "";
  }
  const indented = lines.map((line) => `    ${line}`).join("\n");
  return `\n${indented}`;
}

function gateError(reason: string, path: string) {
  return (cause: unknown): MermaidGateError =>
    new MermaidGateError({ reason, path, cause });
}

function walkInto(
  ctx: WalkCtx,
  dir: string,
): Effect.Effect<void, MermaidGateError> {
  return Effect.gen(function* () {
    const entries = yield* ctx.fs
      .readDirectory(dir)
      .pipe(Effect.mapError(gateError("cannot read directory", dir)));
    for (const name of entries) {
      yield* visitEntry(ctx, dir, name);
    }
  });
}

function visitEntry(
  ctx: WalkCtx,
  dir: string,
  name: string,
): Effect.Effect<void, MermaidGateError> {
  return Effect.gen(function* () {
    if (SKIP_DIRS.has(name)) {
      return;
    }
    const full = ctx.path.resolve(dir, name);
    const info = yield* ctx.fs
      .stat(full)
      .pipe(Effect.mapError(gateError("cannot stat", full)));
    if (info.type === "Directory") {
      yield* walkInto(ctx, full);
      return;
    }
    if (
      StringOps.endsWith(".md")(name) ||
      StringOps.endsWith(".mdx")(name) ||
      (StringOps.endsWith(".ts")(name) &&
        ["packages", "plugins"].some((root) =>
          full.includes(`${ctx.path.sep}${root}${ctx.path.sep}`),
        ))
    ) {
      ctx.out.push(full);
    }
  });
}
