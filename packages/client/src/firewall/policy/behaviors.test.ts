/** @file Owner behavior files resolve before composition and preserve fixed policy and editable state. */

import { live as it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Option } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Tests create exact owner behavior files around the configuration boundary.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "vitest";
import {
  stateDirectory,
  withStore,
} from "../../__tests__/store-schema-fixtures.js";
import { readCredential } from "../../daemon/credentials.js";
import { Daemon } from "../../daemon/index.js";
import {
  firewallInstallation,
  installEditableFirewall,
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
};
const INITIAL = {
  id: "inline-initial",
  kind: "norm",
  text: "Be brief.",
  guidance: "Keep it brief.",
};
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
  return loaded(path).pipe(
    Effect.flatMap(({ policy, provider }) =>
      messagePolicyFirewall(policy, provider),
    ),
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
        expect(read.fixedRules).toMatchObject([
          { id: FIXED.id },
          { id: "working-hours" },
        ]);
        expect(read.rules).toEqual(policy.english?.initialRules);
        const error = yield* installed.policy
          .update({ remove: ["working-hours"] })
          .pipe(Effect.flip);
        expect(error.reason).toBe("fixed-rule");
        expect(yield* installed.policy.read()).toEqual(read);
      }),
    );
  }),
);

it(
  "accepts a behavior at the 64 KiB byte limit",
  Effect.fn(function* () {
    const { path } = fixture(BEHAVIOR.padEnd(65_536, " "));
    const { policy } = yield* loaded(path);
    expect(policy.english?.fixedRules[1]?.text).toBe(BODY);
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
    expect(policy.english?.initialRules[1]?.guidance).toBe(
      "Ask first.\nWait for permission.\n",
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
    expect(error.message).toContain("english.initialBehaviors[0]");
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
    writeFileSync(
      path,
      JSON.stringify({
        ...document,
        english: {
          fixedRules: [FIXED],
          initialRules: [INITIAL],
          fixedBehaviors: [],
          initialBehaviors: [],
        },
      }),
    );
    const second = yield* firewallInstallation(
      { messagePolicyFile: path },
      readCredential,
    );
    expect(second.options?.codeDigest).toBe(first.codeDigest);
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
    expect(error.message).toContain("english.initialBehaviors[0]");
    const startup = yield* startupFailure(path, root);
    expect(startup.phase).toBe("configuration");
    expect(startup.message).toContain("english.initialBehaviors[0]");
  }),
);

const INVALID_BEHAVIORS = [
  ["missing directory", "absent", BEHAVIOR],
  ["missing file", ".", BEHAVIOR],
  ["absolute path", "/private-owner-directory", BEHAVIOR],
  ["Windows absolute path", "C:\\private-owner-directory", BEHAVIOR],
  ["parent traversal", "fixed/../fixed", BEHAVIOR],
  ["missing frontmatter", "fixed", "private-invalid-behavior"],
  ["invalid YAML", "fixed", "---\nname: [private-invalid-behavior\n---\nText"],
  ["missing name", "fixed", BEHAVIOR.replace("name: working-hours\n", "")],
  [
    "missing description",
    "fixed",
    BEHAVIOR.replace(
      "description: When the agent may start conversations.\n",
      "",
    ),
  ],
  [
    "unknown harness key",
    "fixed",
    BEHAVIOR.replace(
      "    kind: safety",
      "    private-invalid-behavior: true\n    kind: safety",
    ),
  ],
  [
    "missing metadata",
    "fixed",
    "---\nname: valid\ndescription: Valid\n---\nText",
  ],
  [
    "invalid kind",
    "fixed",
    BEHAVIOR.replace("kind: safety", "kind: private-invalid-behavior"),
  ],
  [
    "norm without guidance",
    "fixed",
    BEHAVIOR.replace("kind: safety", "kind: norm"),
  ],
  [
    "invalid feedback",
    "fixed",
    BEHAVIOR.replace(
      "nextAction: wait",
      "nextAction: private-invalid-behavior",
    ),
  ],
  ["empty body", "fixed", BEHAVIOR.replace(BODY, "")],
  ["oversized file", "fixed", BEHAVIOR + "x".repeat(65_536)],
  [
    "duplicate fixed inline id",
    "fixed",
    BEHAVIOR.replace("name: working-hours", "name: inline-fixed"),
  ],
] as const;

describe.each(["fixedBehaviors", "initialBehaviors"] as const)(
  "%s",
  (field) => {
    // @agent-code-guard/regression-only: Every case is an owner configuration refusal with a safe indexed path at daemon startup.
    it.each(INVALID_BEHAVIORS)(
      "fails configuration for %s, naming only its policy path",
      ([, directory, text]) =>
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
          expect(error.message).toContain(`english.${field}[0]`);
          expect(error.message).not.toContain("private-invalid-behavior");
          const startup = yield* startupFailure(path, root);
          expect(startup.phase).toBe("configuration");
          expect(startup.message).toContain(`english.${field}[0]`);
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
      expect(error.message).toContain(`english.${field}[0]`);
      const startup = yield* startupFailure(path, root);
      expect(startup.phase).toBe("configuration");
      expect(startup.message).toContain(`english.${field}[0]`);
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
    expect(error.message).toContain("english.fixedBehaviors[1]");
    const startup = yield* startupFailure(path, root);
    expect(startup.phase).toBe("configuration");
    expect(startup.message).toContain("english.fixedBehaviors[1]");
  }),
);

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore assertion defaults outside owner policy contract tests. */
