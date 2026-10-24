/**
 * @file Report for the workspace `lint:effect` target. Runs the Effect
 * language service over package and plugin `tsconfig.json` files, deduplicates the
 * diagnostics that projects sharing a file report twice, and prints counts by
 * severity, rule, and package as JSON. `--details` adds every diagnostic.
 *
 * It reports rather than gates: findings never change its exit code. It fails
 * only when the language service produces no report it can read.
 */
import { Command, FileSystem, Path } from "@effect/platform";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Data, Effect, Schema } from "effect";
import { resolve } from "node:path";

const diagnosticSchema = Schema.Struct(
  {
    file: Schema.String,
    start: Schema.Number,
    name: Schema.String,
    severity: Schema.String,
  },
  Schema.Record({ key: Schema.String, value: Schema.Unknown }),
);
type Diagnostic = typeof diagnosticSchema.Type;

const diagnosticsReportSchema = Schema.parseJson(
  Schema.Struct({
    summary: Schema.Unknown,
    diagnostics: Schema.Array(diagnosticSchema),
  }),
);

/** The language service printed nothing readable for one project. */
class EffectDiagnosticsError extends Data.TaggedError(
  "EffectDiagnosticsError",
)<{ readonly config: string; readonly detail: string }> {
  override get message(): string {
    return `effect-tsgo produced no JSON for ${this.config}: ${this.detail}`;
  }
}

const workspaceRoot = resolve(import.meta.dirname, "..", "..");
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- one boolean flag; the workspace has no @effect/cli dependency
const detailed = process.argv.includes("--details");

const program = Effect.gen(function* () {
  const configs = yield* packageConfigs();
  const reports = yield* Effect.forEach(configs, diagnose, { concurrency: 1 });
  const path = yield* Path.Path;
  const byKey = new Map<string, Diagnostic>();
  for (const { diagnostics } of reports) {
    for (const diagnostic of diagnostics) {
      const file = path.relative(workspaceRoot, diagnostic.file);
      byKey.set(`${file}:${diagnostic.start}:${diagnostic.name}`, {
        ...diagnostic,
        file,
      });
    }
  }
  const summaries = reports.map(({ config, summary }) => ({ config, summary }));
  yield* Effect.sync(() => {
    process.stdout.write(
      `${JSON.stringify(render(summaries, [...byKey.values()]), null, 2)}\n`,
    );
  });
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeContext.layer)));

/** Every package or plugin TypeScript project, relative to the workspace root. */
function packageConfigs() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const candidates = (yield* Effect.forEach(
      ["packages", "plugins"],
      configsInRoot,
      {
        concurrency: 1,
      },
    )).flat();
    return yield* Effect.filter(
      candidates,
      (config) => fs.exists(path.join(workspaceRoot, config)),
      { concurrency: 1 },
    );
  });
}

function configsInRoot(root: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const names = yield* fs.readDirectory(path.join(workspaceRoot, root));
    return names.map((name) => path.join(root, name, "tsconfig.json"));
  });
}

function diagnose(config: string) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const output = yield* Command.make(
      path.join(workspaceRoot, "node_modules/.bin/effect-tsgo"),
      "diagnostics",
      "--project",
      config,
      "--format",
      "json",
    ).pipe(Command.workingDirectory(workspaceRoot), Command.string);
    const report = yield* Schema.decodeUnknown(diagnosticsReportSchema)(
      output.trim(),
    ).pipe(
      Effect.catchTag("ParseError", (cause) =>
        Effect.fail(
          new EffectDiagnosticsError({ config, detail: cause.message }),
        ),
      ),
    );
    return { config, ...report };
  });
}

function render(
  summaries: ReadonlyArray<{
    readonly config: string;
    readonly summary: unknown;
  }>,
  diagnostics: readonly Diagnostic[],
) {
  return {
    configs: summaries,
    deduplicated: {
      total: diagnostics.length,
      bySeverity: countBy(diagnostics, ({ severity }) => severity),
      byRule: countBy(diagnostics, ({ name }) => name),
      byProject: countBy(diagnostics, ({ file }) =>
        file.split("/").slice(0, 2).join("/"),
      ),
    },
    ...(detailed ? { diagnostics } : {}),
  };
}

/** Counts per key, most frequent first. */
function countBy(
  diagnostics: readonly Diagnostic[],
  selector: (diagnostic: Diagnostic) => string,
): Record<string, number> {
  const counts = new Map<string, number>();
  for (const diagnostic of diagnostics) {
    const value = selector(diagnostic);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort((left, right) => right[1] - left[1]),
  );
}
