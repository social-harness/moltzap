#!/usr/bin/env node
/**
 * @file Drift gate for hardcoded Social Harness compatibility values in docs.
 *
 * The companion to `scripts/docs/generate-constants-snippets.ts`: that
 * script writes `docs/snippets/constants/values.{mdx,json}` from the
 * authoritative source files; this script scans every other doc for
 * literal occurrences of those values. A match outside the constants
 * snippet (or an explicit allowlist of auto-generated trees) is a
 * fail — the doc must `import` the value from the snippet instead.
 *
 * The exact `V2_PROTOCOL_VERSION`, `NODE_VERSION_RANGE`, and
 * `OPENCLAW_MIN_VERSION` values come from `docs/snippets/constants/values.json`.
 *
 * Plus a structural sweep for any other version-shaped literal
 * `\d{4}\.\d{3,4}\.\d+` in `docs/`, to catch new doc drift before
 * it ships.
 *
 * Exit codes:
 *   0 — no violations.
 *   1 — at least one literal found outside the allowlist; details
 *       printed with `file:line` + the constant it should be sourced
 *       from.
 *
 * Wired into `pnpm docs:check:no-hardcoded-constants`; called by
 * `pnpm docs:check:drift` for additive coverage.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, "..", "..");
const docsDir = resolve(workspaceRoot, "docs");
const valuesJsonPath = resolve(docsDir, "snippets", "constants", "values.json");

/**
 * Directories whose contents are themselves auto-generated and may
 * legitimately contain the watched literals.
 * `docs/snippets/constants/` is the snippet target.
 * `docs/modules/` is the typedoc dump
 * (`pnpm docs:generate` re-renders it from JSDoc + source).
 *
 * Each entry is matched as a path prefix relative to `workspaceRoot`.
 */
const ALLOW_PREFIXES: readonly string[] = [
  "docs/snippets/constants/",
  "docs/modules/",
];

// Files that carry `{/* @bake-constants: NAME1 NAME2 ... */}` opt into
// generator-bake of the listed constants (see
// `scripts/docs/generate-constants-snippets.ts`). The literal value lives in
// the file by design — the bake step is the source of truth, and
// `pnpm docs:check:drift` catches drift via `git diff --exit-code` after
// regeneration. The gate's per-rule scan SKIPS rules whose constant name
// is listed in this file's marker; unlisted constants still flag.
// eslint-disable-next-line sonarjs/slow-regex -- The input is bounded, repository-owned documentation or a fixed test fixture.
const BAKE_MARKER_RE = /\{\/\*\s*@bake-constants:\s*([A-Z0-9_\s]+?)\s*\*\/\}/;

interface ConstantRecord {
  readonly name: string;
  readonly value: string | number;
  readonly kind: "string" | "number";
  readonly sourcePath: string;
}

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly rule: string;
  readonly hint: string;
}

interface Rule {
  readonly name: string;
  readonly regex: RegExp;
  readonly hint: string;
  /** Pre-check that filters out false positives before matching. */
  readonly skipLine?: (line: string) => boolean;
}

function main(): void {
  const constants = loadConstants();
  const rules = buildRules(constants);
  const docFiles = walkDocs(docsDir);
  const readmePath = resolve(workspaceRoot, "README.md");
  const targets = [...docFiles, readmePath];
  const violations: Violation[] = [];
  for (const f of targets) {
    violations.push(...scanFile(f, rules, constants));
  }
  if (violations.length === 0) {
    console.log(
      `[check-no-hardcoded-constants] OK — ${targets.length} files scanned, no hardcoded constants outside the allowlist.`,
    );
    process.exit(0);
  }
  console.error(
    `[check-no-hardcoded-constants] FAIL — ${violations.length} violation(s):\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.rule}]`);
    console.error(`    ${v.text}`);
    console.error(`    → ${v.hint}\n`);
  }
  process.exit(1);
}

function loadConstants(): readonly ConstantRecord[] {
  const raw = readFileSync(valuesJsonPath, "utf8");
  const parsed =
    /* Safe because Generated constants JSON has this shape; the required array is checked below. */ JSON.parse(
      raw,
    ) as {
      constants?: ConstantRecord[];
    };
  if (!parsed.constants || !Array.isArray(parsed.constants)) {
    console.error(
      `check-no-hardcoded-constants: ${valuesJsonPath} is malformed (missing 'constants' array). Run \`pnpm docs:generate\` first.`,
    );
    process.exit(1);
  }
  return parsed.constants;
}

function walkDocs(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const abs = resolve(dir, entry);
      const st = statSync(abs);
      if (st.isDirectory()) {
        visit(abs);
      } else if (isDocFile(abs)) {
        out.push(abs);
      }
    }
  };
  visit(root);
  return out;
}

function isDocFile(path: string): boolean {
  return path.endsWith(".md") || path.endsWith(".mdx");
}

/** A placeholder exempts a line only when no real calendar-version literal appears alongside it. */
function buildRules(constants: readonly ConstantRecord[]): readonly Rule[] {
  const byName = new Map(constants.map((c) => [c.name, c]));
  const escape = (s: string): string =>
    s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rules: Rule[] = [];
  const v2ProtocolVersion = byName.get("V2_PROTOCOL_VERSION");
  if (v2ProtocolVersion?.kind === "string") {
    rules.push({
      name: "V2_PROTOCOL_VERSION",
      regex: new RegExp(
        escape(
          /* Safe because String-kind records are emitted with string values by the generator. */ v2ProtocolVersion.value as string,
        ),
      ),
      hint: "Mark the file with `{/* @bake-constants: V2_PROTOCOL_VERSION */}` so the compatibility value is baked from `packages/client/src/identity/wire-version.ts`.",
    });
  }

  for (const name of ["NODE_VERSION_RANGE", "OPENCLAW_MIN_VERSION"]) {
    const constant = byName.get(name);
    if (constant?.kind === "string") {
      rules.push({
        name,
        regex: new RegExp(
          escape(
            /* Safe because String-kind records are emitted with string values by the generator. */ constant.value as string,
          ),
        ),
        hint: `Mark the file with \`{/* @bake-constants: ${name} */}\` so the value is baked from \`${constant.sourcePath}\`.`,
      });
    }
  }

  rules.push({
    name: "VERSION_SHAPED_LITERAL",
    regex: /\b\d{4}\.\d{3,4}\.\d+\b/,
    hint: `Mark compatibility values with \`{/* @bake-constants: V2_PROTOCOL_VERSION */}\` so \`scripts/docs/generate-constants-snippets.ts\` keeps them in sync. For non-version examples, use the placeholder string \`YYYY.MDD.patch\` on its own.`,
    skipLine: (line) =>
      line.includes("YYYY.MDD.patch") &&
      !/\b\d{4}\.\d{3,4}\.\d+\b/.test(line.replace(/YYYY\.MDD\.patch/g, "")),
  });
  return rules;
}

function scanFile(
  absPath: string,
  rules: readonly Rule[],
  constants: readonly ConstantRecord[],
): readonly Violation[] {
  const relPath = relative(workspaceRoot, absPath);
  if (isAllowed(relPath)) {
    return [];
  }
  const text = readFileSync(absPath, "utf8");
  const bakedConstants = readBakedConstants(text);
  const bakedVersionValues = new Set(
    constants
      .filter(
        (constant) =>
          constant.kind === "string" &&
          constant.name === "V2_PROTOCOL_VERSION" &&
          bakedConstants.has(constant.name),
      )
      .map(
        (constant) =>
          /* Safe because The preceding kind filter selects generated string records. */ constant.value as string,
      ),
  );
  const lines = text.split("\n");
  const violations: Violation[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const rule of rules) {
      const checkedLine = checkedRuleLine(line, rule, bakedVersionValues);
      if (bakedConstants.has(rule.name) || !matchesRule(rule, checkedLine)) {
        continue;
      }
      violations.push({
        file: relPath,
        line: i + 1,
        text: line.trim(),
        rule: rule.name,
        hint: rule.hint,
      });
    }
  }
  return violations;
}

function isAllowed(relPath: string): boolean {
  return ALLOW_PREFIXES.some((p) => relPath.startsWith(p));
}

function readBakedConstants(text: string): ReadonlySet<string> {
  const m = BAKE_MARKER_RE.exec(text);
  if (m === null) {
    return new Set();
  }
  const names = (m[1] ?? "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return new Set(names);
}

function checkedRuleLine(
  line: string,
  rule: Rule,
  bakedVersionValues: ReadonlySet<string>,
): string {
  if (rule.name !== "VERSION_SHAPED_LITERAL") {
    return line;
  }
  return line.replace(/\b\d{4}\.\d{3,4}\.\d+\b/g, (token) =>
    bakedVersionValues.has(token) ? "" : token,
  );
}

function matchesRule(rule: Rule, line: string): boolean {
  return !rule.skipLine?.(line) && rule.regex.test(line);
}

main();
