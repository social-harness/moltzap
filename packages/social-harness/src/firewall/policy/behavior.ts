/** @file Maps one `BEHAVIOR.md`, from a policy file or a message, to an English rule. */

import { Effect, Schema } from "effect";
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import type { BehaviorFailure } from "./configuration.js";
import { exactStruct } from "../../encoding/exact.js";
import { EnglishRule, policyReadSchema } from "../evaluator/index.js";

/** The Behaviors spec limits each BEHAVIOR.md to 64 KiB: docs/spec/harness/message-policy.md#behaviors. */
export const MAXIMUM_BEHAVIOR_BYTES = 65_536;

/** YAML owns frontmatter syntax; only Social Harness metadata is a closed namespace. */
const behaviorFrontmatter = Schema.Struct({
  name: Schema.NonEmptyTrimmedString,
  description: Schema.NonEmptyString,
  metadata: Schema.Struct({
    "social-harness": exactStruct({
      kind: Schema.optionalWith(EnglishRule.fields.kind, {
        default: () => "norm" as const,
      }),
      guidance: EnglishRule.fields.guidance,
      feedback: EnglishRule.fields.feedback,
    }),
  }),
});

/**
 * Maps one `BEHAVIOR.md` to its editable English rule and the SHA-256 of its
 * bytes. YAML parser diagnostics stay private; only a closed category reaches
 * `refused`, which builds the caller's own failure.
 * @param bytes The behavior's bytes; callers bound them by {@link MAXIMUM_BEHAVIOR_BYTES}.
 * @param refused The caller's failure for a closed category.
 * @returns The rule and the digest of the bytes.
 */
export function decodeBehavior<Failure>(
  bytes: Buffer,
  refused: (reason: BehaviorFailure) => Failure,
) {
  return Effect.gen(function* () {
    const parts = /^---\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)([\s\S]*)/mu.exec(
      bytes.toString("utf8").replace(/^\uFEFF/u, ""),
    );
    if (
      parts?.[1] === undefined ||
      parts[2] === undefined ||
      parts.index !== 0
    ) {
      return yield* Effect.fail(refused("frontmatter"));
    }
    const frontmatter = yield* decodeFrontmatter(parts[1], refused);
    const metadata = frontmatter.metadata["social-harness"];
    const rules = yield* Schema.decodeUnknown(policyReadSchema.fields.rules)([
      {
        id: frontmatter.name,
        text: parts[2].trim(),
        ...metadata,
      },
    ]).pipe(Effect.mapError(() => refused("schema")));
    const rule = yield* Effect.fromNullable(rules[0]).pipe(
      Effect.mapError(() => refused("schema")),
    );
    return { rule, digest: createHash("sha256").update(bytes).digest("hex") };
  }).pipe(Effect.withSpan("decodeBehavior"));
}

/** YAML diagnostics stay inside the parser boundary, including unresolved tags. */
function decodeFrontmatter<Failure>(
  text: string,
  refused: (reason: BehaviorFailure) => Failure,
) {
  return Effect.gen(function* () {
    const doc = yield* Effect.try({
      try: () =>
        parseDocument(text, {
          schema: "core",
          resolveKnownTags: false,
          logLevel: "error",
        }),
      catch: () => refused("frontmatter"),
    });
    if (doc.errors.length !== 0 || doc.warnings.length !== 0) {
      return yield* Effect.fail(refused("frontmatter"));
    }
    return yield* Effect.try({
      try: (): unknown => doc.toJS(),
      catch: () => refused("frontmatter"),
    }).pipe(
      Effect.flatMap((value) =>
        Schema.decodeUnknown(behaviorFrontmatter)(value).pipe(
          Effect.mapError(() => refused("schema")),
        ),
      ),
    );
  });
}
