/** @file Behaviors, from owner files or a policy_update, map to English rules and preserve fixed policy and editable state. */

import { live as it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Option, Schema } from "effect";
import { spawnSync } from "node:child_process";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Tests create exact owner behavior files around the configuration boundary.
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "vitest";
import {
  stateDirectory,
  withStore,
} from "../../__tests__/store-schema-fixtures.js";
import { readCredential } from "../../daemon/credentials.js";
import { Daemon } from "../../daemon/index.js";
import { FirewallPolicyError } from "../evaluator/index.js";
import { localGuidanceImpersonationRule } from "../rules/index.js";
import { policyInstallationError } from "./compose.js";
import { MAXIMUM_BEHAVIOR_BYTES } from "./document/index.js";
import {
  decodeMessagePolicy,
  firewallInstallation,
  installEditableFirewall,
  MessagePolicy,
  messagePolicyFirewall,
} from "./index.js";
import { loadMessagePolicy } from "./load.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Rule fields, policy entry paths and startup phases are the owner policy contract. */

const FORMAT = "org.social-harness/message-policy/v1";
const BODY = "Start conversations during working hours.";
const FIXED = {
  id: "inline-fixed",
  kind: "safety",
  text: "Protect owner data.",
} as const;
const INITIAL = {
  id: "inline-initial",
  kind: "norm",
  text: "Be brief.",
  guidance: "Keep it brief.",
} as const;
const BEHAVIOR = `---
name: working-hours
description: When the agent may start conversations.
license: MIT
metadata:
  another-consumer: ignored
  social-harness:
    kind: safety
    feedback:
      text: Wait until working hours.
      nextAction: wait
---

${BODY}

`;
const NORM = `---
name: ask-first
description: Ask before starting a conversation.
metadata:
  social-harness:
    guidance: Ask first.
---
Ask before starting a conversation.
`;
const SHARED = `---
name: meeting-booking
description: How members book a meeting.
metadata:
  social-harness:
    kind: norm
    guidance: Hold a slot before you confirm one.
    feedback:
      text: Hold the slot first.
      nextAction: revise
---

Each member holds a slot before confirming it.
`;

function seedFixture(count: number) {
  const subject = fixture();
  writeFileSync(
    subject.path,
    JSON.stringify({
      ...subject.document,
      english: {
        ...subject.document.english,
        initialRules: Array.from({ length: count }, () => INITIAL).map(
          (rule, index) => ({
            ...rule,
            id: `seed-${index}`,
          }),
        ),
      },
    }),
  );
  return subject;
}

function fixture(fixed = BEHAVIOR, initial = NORM) {
  const root = stateDirectory();
  mkdirSync(join(root, "fixed"));
  mkdirSync(join(root, "initial"));
  writeFileSync(join(root, "fixed", "BEHAVIOR.md"), fixed);
  writeFileSync(join(root, "initial", "BEHAVIOR.md"), initial);
  const path = join(root, "policy.json");
  const document = {
    format: FORMAT,
    mode: "guidance",
    decisionProvider: { kind: "unavailable" },
    english: {
      fixedRules: [FIXED],
      initialRules: [INITIAL],
      fixedBehaviors: ["fixed"],
      initialBehaviors: ["initial"],
    },
  };
  writeFileSync(path, JSON.stringify(document));
  return { root, path, document };
}

function options(path: string) {
  return firewallInstallation({ messagePolicyFile: path }, readCredential).pipe(
    Effect.flatMap((installation) => Effect.fromNullable(installation.options)),
  );
}

function loaded(path: string) {
  return loadMessagePolicy({ messagePolicyFile: path }, readCredential).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.die("expected a configured message policy"),
        onSome: Effect.succeed,
      }),
    ),
  );
}

it(
  "appends fixed and initial behaviors to inline rules and exposes them through policy_read",
  Effect.fn(function* () {
    const { path } = fixture();
    const { policy } = yield* loaded(path);
    expect(policy.english?.fixedRules).toEqual([
      FIXED,
      {
        id: "working-hours",
        kind: "safety",
        text: BODY,
        feedback: { text: "Wait until working hours.", nextAction: "wait" },
      },
    ]);
    expect(policy.english?.initialRules).toEqual([
      INITIAL,
      {
        id: "ask-first",
        kind: "norm",
        text: "Ask before starting a conversation.",
        guidance: "Ask first.",
      },
    ]);
    const configuration = yield* options(path);
    yield* withStore(stateDirectory(), (store) =>
      Effect.gen(function* () {
        const installed = yield* installEditableFirewall(configuration, store);
        const read = yield* installed.policy.read();
        expect(read.fixedRules).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: FIXED.id }),
            expect.objectContaining({ id: "working-hours" }),
          ]),
        );
        expect(read.rules).toEqual(policy.english?.initialRules);
        const error = yield* installed.policy
          .update({ remove: ["working-hours"] })
          .pipe(Effect.flip);
        expect(error).toMatchObject({
          reason: "fixed-rule",
          ruleId: "working-hours",
          path: ["remove", 0],
        });
        expect(yield* installed.policy.read()).toEqual(read);
      }),
    );
  }),
);

it(
  "accepts a behavior at the 64 KiB byte limit",
  Effect.fn(function* () {
    const { path } = fixture(BEHAVIOR.padEnd(MAXIMUM_BEHAVIOR_BYTES, " "));
    const { policy } = yield* loaded(path);
    expect(policy.english?.fixedRules).toContainEqual(
      expect.objectContaining({ id: "working-hours", text: BODY }),
    );
  }),
);

it(
  "reads YAML block scalars and CRLF frontmatter",
  Effect.fn(function* () {
    const text = NORM.replace(
      "guidance: Ask first.",
      "guidance: |\n      Ask first.\n      Wait for permission.",
    ).replaceAll("\n", "\r\n");
    const { path } = fixture(BEHAVIOR, text);
    const { policy } = yield* loaded(path);
    expect(policy.english?.initialRules).toContainEqual(
      expect.objectContaining({
        id: "ask-first",
        guidance: "Ask first.\nWait for permission.\n",
      }),
    );
  }),
);

it(
  "keeps an existing editable document when initial behaviors change",
  Effect.fn(function* () {
    const { path, root } = fixture();
    const state = stateDirectory();
    const first = yield* options(path);
    yield* withStore(state, (store) =>
      Effect.gen(function* () {
        const installed = yield* installEditableFirewall(first, store);
        yield* installed.policy.update({ remove: [INITIAL.id, "ask-first"] });
      }),
    );
    writeFileSync(
      join(root, "initial", "BEHAVIOR.md"),
      NORM.replace("Ask first.", "Consult the owner first."),
    );
    const next = yield* options(path);
    yield* withStore(state, (store) =>
      Effect.gen(function* () {
        const restarted = yield* installEditableFirewall(next, store);
        expect((yield* restarted.policy.read()).rules).toEqual([]);
      }),
    );
    writeFileSync(
      join(root, "initial", "BEHAVIOR.md"),
      "private-invalid-behavior",
    );
    const error = yield* loaded(path).pipe(Effect.flip);
    expect(error.message).toContain("english.initialBehaviors.0");
  }),
);

it(
  "hashes fixed behavior bytes including metadata and leaves initial behavior bytes out",
  Effect.fn(function* () {
    const { path, root } = fixture();
    const first = yield* options(path);
    writeFileSync(
      join(root, "fixed", "BEHAVIOR.md"),
      BEHAVIOR.replace("license: MIT", "license: Apache-2.0"),
    );
    const fixedChanged = yield* options(path);
    expect(fixedChanged.codeDigest).not.toBe(first.codeDigest);
    expect(fixedChanged.english?.fixedRules).toEqual(first.english?.fixedRules);
    writeFileSync(
      join(root, "initial", "BEHAVIOR.md"),
      NORM.replace("Ask first.", "Consult the owner first."),
    );
    const initialChanged = yield* options(path);
    expect(initialChanged.codeDigest).toBe(fixedChanged.codeDigest);
  }),
);

it(
  "keeps the code digest of policies with inline rules and no behaviors",
  Effect.fn(function* () {
    const { path, document } = fixture();
    writeFileSync(
      path,
      JSON.stringify({
        ...document,
        english: { fixedRules: [FIXED], initialRules: [INITIAL] },
      }),
    );
    const first = yield* options(path);
    const trusted = yield* messagePolicyFirewall(
      {
        format: FORMAT,
        mode: "guidance",
        incoming: [],
        outgoing: [],
        english: {
          fixedRules: [FIXED],
          initialRules: [INITIAL],
          fixedBehaviors: [],
          initialBehaviors: [],
        },
        decisionProvider: { kind: "unavailable" },
        settings: {
          timeoutMilliseconds: 150_000,
          middlewareTimeoutMilliseconds: 70_000,
          maximumInputBytes: 512_000,
          maximumResultBytes: 2_000_000,
        },
        englishSettings: {
          minimumProbability: 0.5,
          maximumRequestBytes: 384_000,
          timeoutMilliseconds: 15_000,
        },
        facts: [],
      },
      { decide: () => Effect.die("no assessment requested") },
    );
    expect(first.codeDigest).toBe(trusted.codeDigest);
  }),
);

it(
  "seeds 255 inline initial rules and one initial behavior",
  Effect.fn(function* () {
    const { path } = seedFixture(255);
    const configuration = yield* options(path);
    yield* withStore(stateDirectory(), (store) =>
      Effect.gen(function* () {
        const installed = yield* installEditableFirewall(configuration, store);
        expect((yield* installed.policy.read()).rules).toHaveLength(256);
      }),
    );
  }),
);

it(
  "names the initial behavior that exceeds the editable rule limit",
  Effect.fn(function* () {
    const { path, root } = seedFixture(256);
    const error = yield* loaded(path).pipe(Effect.flip);
    expect(error.behaviorReason).toBe("editable-limit");
    expect(error.message).toContain("english.initialBehaviors.0");
    const startup = yield* startupFailure(path, root);
    expect(startup.phase).toBe("configuration");
    expect(startup.message).toContain("english.initialBehaviors.0");
  }),
);

it("attributes an invalid inline seed to initialRules before reading behaviors", () =>
  Effect.gen(function* () {
    const { path, document } = fixture();
    writeFileSync(
      path,
      JSON.stringify({
        ...document,
        english: {
          ...document.english,
          initialRules: [{ id: INITIAL.id, kind: "norm", text: INITIAL.text }],
          fixedBehaviors: ["absent"],
        },
      }),
    );
    const error = yield* loaded(path).pipe(Effect.flip);
    expect(error.message).toContain("invalid at english.initialRules");
    expect(error.behaviorReason).toBeUndefined();
  }));

const INVALID_BEHAVIORS = [
  [
    "custom tag",
    "frontmatter",
    "fixed",
    BEHAVIOR.replace(
      "license: MIT",
      "license: !private-invalid-behavior secret",
    ),
  ],
  [
    "binary tag",
    "frontmatter",
    "fixed",
    BEHAVIOR.replace("license: MIT", "license: !!binary c2VjcmV0"),
  ],
  ["missing directory", "missing", "absent", BEHAVIOR],
  ["missing file", "missing", ".", BEHAVIOR],
  ["absolute path", "schema", "/private-owner-directory", BEHAVIOR],
  ["Windows absolute path", "schema", "C:\\private-owner-directory", BEHAVIOR],
  ["parent traversal", "schema", "fixed/../fixed", BEHAVIOR],
  ["missing frontmatter", "frontmatter", "fixed", "private-invalid-behavior"],
  [
    "invalid YAML",
    "frontmatter",
    "fixed",
    "---\nname: [private-invalid-behavior\n---\nText",
  ],
  [
    "missing name",
    "schema",
    "fixed",
    BEHAVIOR.replace("name: working-hours\n", ""),
  ],
  [
    "missing description",
    "schema",
    "fixed",
    BEHAVIOR.replace(
      "description: When the agent may start conversations.\n",
      "",
    ),
  ],
  [
    "unknown harness key",
    "schema",
    "fixed",
    BEHAVIOR.replace(
      "    kind: safety",
      "    private-invalid-behavior: true\n    kind: safety",
    ),
  ],
  [
    "missing metadata",
    "schema",
    "fixed",
    "---\nname: valid\ndescription: Valid\n---\nText",
  ],
  [
    "invalid kind",
    "schema",
    "fixed",
    BEHAVIOR.replace("kind: safety", "kind: private-invalid-behavior"),
  ],
  [
    "norm without guidance",
    "schema",
    "fixed",
    BEHAVIOR.replace("kind: safety", "kind: norm"),
  ],
  [
    "invalid feedback",
    "schema",
    "fixed",
    BEHAVIOR.replace(
      "nextAction: wait",
      "nextAction: private-invalid-behavior",
    ),
  ],
  ["empty body", "schema", "fixed", BEHAVIOR.replace(BODY, "")],
  [
    "oversized file",
    "too-large",
    "fixed",
    BEHAVIOR.padEnd(MAXIMUM_BEHAVIOR_BYTES + 1, " "),
  ],
  [
    "duplicate fixed inline id",
    "duplicate-id",
    "fixed",
    BEHAVIOR.replace("name: working-hours", "name: inline-fixed"),
  ],
  [
    "duplicate YAML key",
    "frontmatter",
    "fixed",
    BEHAVIOR.replace(
      "name: working-hours",
      "name: working-hours\nname: secret",
    ),
  ],
] as const;

describe.each(["fixedBehaviors", "initialBehaviors"] as const)(
  "%s",
  (field) => {
    // @agent-code-guard/regression-only: Every case is an owner configuration refusal with a safe indexed path at daemon startup.
    it.each(INVALID_BEHAVIORS)(
      "fails configuration for %s, naming only its policy path",
      ([, reason, directory, text]) =>
        Effect.gen(function* () {
          const { path, root, document } = fixture(text);
          writeFileSync(
            path,
            JSON.stringify({
              ...document,
              english: {
                ...document.english,
                fixedBehaviors: [],
                initialBehaviors: [],
                [field]: [directory],
              },
            }),
          );
          const error = yield* loaded(path).pipe(Effect.flip);
          expect(error.behaviorReason).toBe(reason);
          expect(error.message).toContain(`english.${field}.0`);
          expect(error.message).not.toContain("private-invalid-behavior");
          const startup = yield* startupFailure(path, root);
          expect(startup.phase).toBe("configuration");
          expect(startup.message).toContain(`english.${field}.0`);
          expect(startup.message).not.toContain("private-invalid-behavior");
        }),
    );
  },
);

/** Policy failures are observed before any agent key or listener is acquired. */
function startupFailure(path: string, root: string) {
  return Layer.build(Daemon.layer).pipe(
    Effect.scoped,
    Effect.withConfigProvider(
      ConfigProvider.fromMap(
        new Map(
          Object.entries({
            SHARNESS_STATE_DIRECTORY: join(root, "state"),
            SHARNESS_MCP_PORT: "4319",
            SHARNESS_REGISTRY_ORIGIN: "https://registry.example",
            SHARNESS_REGISTRY_SIGNER_PUBLIC_KEY: JSON.stringify({
              crv: "Ed25519",
              kty: "OKP",
              x: "y1j1FUgbqjCPeQVEnllv-2euwn_s9DeDkfEh3gk_OJ0",
            }),
            SHARNESS_ROUTER_ORIGIN: "https://router.example",
            SHARNESS_AGENT_PRIVATE_KEY_FILE: join(root, "absent-agent-key.pem"),
            SHARNESS_MESSAGE_POLICY_FILE: path,
          }),
        ),
      ),
    ),
    Effect.flip,
  );
}

it.each(["fixedBehaviors", "initialBehaviors"] as const)(
  "refuses a %s id already owned by code",
  (field) =>
    Effect.gen(function* () {
      const { path, root, document } = fixture(
        BEHAVIOR.replace("name: working-hours", "name: credentials"),
      );
      writeFileSync(
        path,
        JSON.stringify({
          ...document,
          outgoing: [{ use: "credentials" }],
          english: {
            ...document.english,
            fixedBehaviors: [],
            initialBehaviors: [],
            [field]: ["fixed"],
          },
        }),
      );
      const error = yield* firewallInstallation(
        { messagePolicyFile: path },
        readCredential,
      ).pipe(Effect.flip);
      expect(error.message).toContain(`english.${field}.0`);
      const startup = yield* startupFailure(path, root);
      expect(startup.phase).toBe("configuration");
      expect(startup.message).toContain(`english.${field}.0`);
    }),
);

it(
  "refuses repeated fixed behaviors at the second entry",
  Effect.fn(function* () {
    const { path, root, document } = fixture();
    writeFileSync(
      path,
      JSON.stringify({
        ...document,
        english: { ...document.english, fixedBehaviors: ["fixed", "fixed"] },
      }),
    );
    const error = yield* loaded(path).pipe(Effect.flip);
    expect(error.message).toContain("english.fixedBehaviors.1");
    const startup = yield* startupFailure(path, root);
    expect(startup.phase).toBe("configuration");
    expect(startup.message).toContain("english.fixedBehaviors.1");
  }),
);

it.each(["", "\uFEFF"])(
  "accepts frontmatter with leading prefix %j",
  (prefix) =>
    Effect.gen(function* () {
      const { path } = fixture(prefix + BEHAVIOR);
      const { policy } = yield* loaded(path);
      expect(policy.english?.fixedRules).toContainEqual(
        expect.objectContaining({ id: "working-hours", text: BODY }),
      );
    }),
);

it("composes and encodes a decoded inline policy without adding behavior paths", () =>
  Effect.gen(function* () {
    const policy = yield* decodeMessagePolicy(
      JSON.stringify({
        format: FORMAT,
        mode: "guidance",
        decisionProvider: { kind: "unavailable" },
        english: { fixedRules: [FIXED], initialRules: [INITIAL] },
      }),
    );
    const encoded = yield* Schema.encode(MessagePolicy)(policy);
    expect(encoded.english).toEqual({
      fixedRules: [FIXED],
      initialRules: [INITIAL],
    });
    const composed = yield* messagePolicyFirewall(policy, {
      decide: () => Effect.die("no assessment requested"),
    });
    expect(composed.english?.fixedRules).toEqual([FIXED]);
    expect(composed.english?.initialRules).toEqual([INITIAL]);
  }));

it.each([
  { field: "fixedBehaviors", entry: "fixed" },
  { field: "initialBehaviors", entry: "fixed" },
  { field: "builtinBehaviors", entry: "policy/no-policy-changes" },
] as const)(
  "refuses unresolved $field in trusted composition",
  ({ field, entry }) =>
    Effect.gen(function* () {
      const { document } = fixture();
      const policy = yield* decodeMessagePolicy(
        JSON.stringify({
          ...document,
          english: { [field]: [entry] },
        }),
      );
      const error = yield* messagePolicyFirewall(policy, {
        decide: () => Effect.die("no assessment requested"),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("CheckInputError");
      expect(error.reason).toBe("registration");
    }),
);

it.each(["directory", "file"] as const)(
  "refuses a behavior %s symlink escaping the policy directory",
  (target) =>
    Effect.gen(function* () {
      const { path, root } = fixture();
      const outside = stateDirectory();
      writeFileSync(join(outside, "BEHAVIOR.md"), BEHAVIOR);
      if (target === "directory") {
        rmSync(join(root, "fixed"), { recursive: true });
        symlinkSync(outside, join(root, "fixed"));
      } else {
        rmSync(join(root, "fixed", "BEHAVIOR.md"));
        symlinkSync(
          join(outside, "BEHAVIOR.md"),
          join(root, "fixed", "BEHAVIOR.md"),
        );
      }
      const error = yield* loaded(path).pipe(Effect.flip);
      expect(error.behaviorReason).toBe("schema");
      expect(error.message).toContain("english.fixedBehaviors.0");
    }),
);

it("refuses a BEHAVIOR.md that is a directory", () =>
  Effect.gen(function* () {
    const { path, root } = fixture();
    rmSync(join(root, "fixed", "BEHAVIOR.md"));
    mkdirSync(join(root, "fixed", "BEHAVIOR.md"));
    const error = yield* loaded(path).pipe(Effect.flip);
    expect(error.behaviorReason).toBe("not-a-file");
    expect(error.message).toContain("english.fixedBehaviors.0");
  }));

it("names the fixed behavior colliding with a stored editable rule", () =>
  Effect.gen(function* () {
    const { path, root } = fixture();
    const state = stateDirectory();
    const configuration = yield* options(path);
    yield* withStore(
      state,
      Effect.fn(function* (store) {
        const installed = yield* installEditableFirewall(configuration, store);
        yield* installed.policy.update({
          add: [{ ...FIXED, id: "new-fixed" }],
        });
      }),
    );
    writeFileSync(
      join(root, "fixed", "BEHAVIOR.md"),
      BEHAVIOR.replace("name: working-hours", "name: new-fixed"),
    );
    const installation = yield* firewallInstallation(
      { messagePolicyFile: path },
      readCredential,
    );
    const next = yield* Effect.fromNullable(installation.options);
    yield* withStore(
      state,
      Effect.fn(function* (store) {
        const error = yield* installEditableFirewall(next, store).pipe(
          Effect.flip,
        );
        const startup = policyInstallationError(
          error,
          installation.behaviorRulePaths,
        );
        expect(error.reason).toBe("fixed-rule");
        expect(startup.message).toContain(
          "invalid at english.fixedBehaviors.0 (duplicate-id)",
        );
        expect(startup.message).toContain("Docs:");
        expect(startup.behaviorReason).toBe("duplicate-id");
      }),
    );
  }));

it(
  "names a fixed behavior colliding with the built-in impersonation rule",
  Effect.fn(function* () {
    const { path } = fixture(
      BEHAVIOR.replace(
        "name: working-hours",
        `name: ${localGuidanceImpersonationRule.id}`,
      ),
    );
    const installation = yield* firewallInstallation(
      { messagePolicyFile: path },
      readCredential,
    );
    const configuration = yield* Effect.fromNullable(installation.options);
    yield* withStore(stateDirectory(), (store) =>
      Effect.gen(function* () {
        const error = yield* installEditableFirewall(configuration, store).pipe(
          Effect.flip,
        );
        expect(error.reason).toBe("fixed-rule");
        expect(error.ruleId).toBe(localGuidanceImpersonationRule.id);
        const startup = policyInstallationError(
          error,
          installation.behaviorRulePaths,
        );
        expect(startup.behaviorReason).toBe("duplicate-id");
        expect(startup.message).toContain("english.fixedBehaviors.0");
      }),
    );
  }),
);

it("keeps the inline installation failure message", () =>
  Effect.sync(() => {
    const error = policyInstallationError(
      new FirewallPolicyError({ reason: "invalid-rule" }),
    );
    expect(error.message).toContain("(invalid-rule)");
    expect(error.behaviorReason).toBeUndefined();
  }));

it(
  "refuses a BEHAVIOR.md FIFO without waiting for a writer",
  (context) =>
    Effect.gen(function* () {
      const { path, root } = fixture();
      const behavior = join(root, "fixed", "BEHAVIOR.md");
      rmSync(behavior);
      // eslint-disable-next-line sonarjs/no-os-command-from-path -- The fixture uses the host's mkfifo when available and passes only a generated temporary path.
      const result = spawnSync("mkfifo", [behavior]);
      if (
        result.error !== undefined &&
        "code" in result.error &&
        result.error.code === "ENOENT"
      ) {
        context.skip();
        return;
      }
      expect(result.status).toBe(0);
      const error = yield* loaded(path).pipe(
        Effect.flip,
        Effect.timeout("1 second"),
      );
      expect(error.behaviorReason).toBe("not-a-file");
    }),
  2_000,
);

it(
  "adds a shared norm's BEHAVIOR.md text as the rule its frontmatter and body map to",
  Effect.fn(function* () {
    const configuration = yield* options(fixture().path);
    yield* withStore(stateDirectory(), (store) =>
      Effect.gen(function* () {
        const installed = yield* installEditableFirewall(configuration, store);
        yield* installed.policy.update({ add: [{ behavior: SHARED }] });
        expect((yield* installed.policy.read()).rules).toContainEqual({
          id: "meeting-booking",
          kind: "norm",
          text: "Each member holds a slot before confirming it.",
          guidance: "Hold a slot before you confirm one.",
          feedback: { text: "Hold the slot first.", nextAction: "revise" },
        });
        const { activations } = yield* installed.policy.decisions({});
        expect(activations).toEqual([
          expect.objectContaining({
            addedRuleIds: ["meeting-booking"],
            removedRuleIds: [],
          }),
        ]);
      }),
    );
  }),
);

/** Edits the fixture's editable rules (`inline-initial`, `ask-first`) cannot apply, and what each refusal names. */
const REFUSED_EDITS = [
  {
    edit: { add: [INITIAL] },
    refusal: {
      reason: "invalid-rule",
      problem: "duplicate-id",
      ruleId: INITIAL.id,
      path: ["add", 0],
    },
  },
  {
    edit: {
      add: [
        { ...INITIAL, id: "twice" },
        { ...INITIAL, id: "twice" },
      ],
    },
    refusal: {
      reason: "invalid-rule",
      problem: "duplicate-id",
      ruleId: "twice",
      path: ["add", 1],
    },
  },
  {
    edit: { remove: ["absent"] },
    refusal: {
      reason: "invalid-rule",
      problem: "unknown-id",
      ruleId: "absent",
      path: ["remove", 0],
    },
  },
  {
    edit: {
      add: [...Array.from({ length: 255 }).keys()].map((index) => ({
        ...INITIAL,
        id: `extra-${String(index)}`,
      })),
    },
    refusal: { reason: "invalid-rule", problem: "editable-limit" },
  },
  {
    edit: { add: [{ ...INITIAL, id: FIXED.id }] },
    refusal: { reason: "fixed-rule", ruleId: FIXED.id, path: ["add", 0] },
  },
  {
    edit: {
      add: [{ behavior: SHARED.replace("kind: norm", "kind: safety") }],
    },
    refusal: {
      reason: "invalid-rule",
      problem: "not-norm",
      ruleId: "meeting-booking",
      path: ["add", 0],
    },
  },
  {
    edit: {
      add: [{ behavior: "Each member holds a slot before confirming it." }],
    },
    refusal: {
      reason: "invalid-rule",
      problem: "frontmatter",
      path: ["add", 0],
    },
  },
  {
    edit: {
      add: [{ behavior: SHARED.padEnd(MAXIMUM_BEHAVIOR_BYTES + 1, " ") }],
    },
    refusal: { reason: "invalid-rule", problem: "too-large", path: ["add", 0] },
  },
] as const;

it.each(REFUSED_EDITS)(
  "refuses an edit, naming its failing rule and problem, and keeps the policy: $refusal",
  ({ edit, refusal }) =>
    refusedEdit(edit).pipe(
      Effect.tap(({ error, before, after }) =>
        Effect.sync(() => {
          expect(error).toMatchObject(refusal);
          expect(error.message).toContain("Docs: ");
          expect(after).toEqual(before);
        }),
      ),
    ),
);

/** The refusal `policy_update` gives `edit` on the fixture's policy, with `policy_read` before and after it. */
function refusedEdit(edit: (typeof REFUSED_EDITS)[number]["edit"]) {
  return Effect.gen(function* () {
    const configuration = yield* options(fixture().path);
    return yield* withStore(stateDirectory(), (store) =>
      Effect.gen(function* () {
        const installed = yield* installEditableFirewall(configuration, store);
        const before = yield* installed.policy.read();
        const error = yield* installed.policy.update(edit).pipe(Effect.flip);
        return { error, before, after: yield* installed.policy.read() };
      }),
    );
  });
}

it(
  "names a builtin behavior Client does not ship by its entry",
  Effect.fn(function* () {
    const { path, document } = fixture();
    writeFileSync(
      path,
      JSON.stringify({
        ...document,
        english: {
          ...document.english,
          builtinBehaviors: ["policy/no-such-behavior"],
        },
      }),
    );
    const error = yield* loaded(path).pipe(Effect.flip);
    expect(error.behaviorReason).toBe("missing");
    expect(error.message).toContain("english.builtinBehaviors.0");
  }),
);

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore assertion defaults outside owner policy contract tests. */
