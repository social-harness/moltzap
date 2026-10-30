/** @file Editable policies retain fixed-rule protection and complete state across restart. */
import { live as it } from "@effect/vitest";
import { Effect, Option } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Tests create exact operator configuration and rule files around real persistent edits.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import {
  stateDirectory,
  withDaemonStore,
} from "../__tests__/store-schema-fixtures.js";
import { readCredential } from "../daemon/credentials.js";
import {
  loadMessagePolicy,
  MAXIMUM_BEHAVIOR_BYTES,
  policyInstallationError,
} from "./config.js";
import { makeFirewall } from "./index.js";
/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Indexed safe errors and atomic policy state are the public edit contract. */

const FORMAT = "org.social-harness/message-policy/v2";

const BODY = "Start conversations during working hours.";

const FIXED = {
  id: "inline-fixed",
  applies: "both",
  text: "Protect owner data.",
} as const;

const INITIAL = {
  id: "inline-initial",
  applies: "both",
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
    applies: both
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
    applies: both
    guidance: Ask first.
---
Ask before starting a conversation.
`;

const SHARED = `---
name: meeting-booking
description: How members book a meeting.
metadata:
  social-harness:
    applies: both
    guidance: Hold a slot before you confirm one.
    feedback:
      text: Hold the slot first.
      nextAction: revise
---

Each member holds a slot before confirming it.
`;

/** Rule-count cases leave enough request budget to isolate the editable-document bound. */
function seedFixture(count: number) {
  const subject = fixture();
  writeFileSync(
    subject.path,
    JSON.stringify({
      ...subject.document,
      textSettings: {
        minimumProbability: 0.5,
        maximumRequestBytes: 1_000_000,
        timeoutMilliseconds: 15_000,
      },
      text: {
        ...subject.document.text,
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
    text: {
      fixedRules: [FIXED],
      initialRules: [INITIAL],
      fixedBehaviors: ["fixed"],
      initialBehaviors: ["initial"],
    },
  };
  writeFileSync(path, JSON.stringify(document));
  return { root, path, document };
}
/** File loading supplies the same validated input as daemon startup. */
function options(path: string) {
  return loadMessagePolicy({ messagePolicyFile: path }, readCredential).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.dieMessage("expected configured policy"),
        onSome: Effect.succeed,
      }),
    ),
  );
}

it(
  "appends fixed and initial behaviors to inline rules and exposes them through policy_read",
  Effect.fn(function* () {
    const { path } = fixture();
    const { policy } = yield* options(path);
    expect(policy.text?.fixedRules).toEqual([
      FIXED,
      {
        id: "working-hours",
        applies: "both",
        text: BODY,
        feedback: { text: "Wait until working hours.", nextAction: "wait" },
      },
    ]);
    expect(policy.text?.initialRules).toEqual([
      INITIAL,
      {
        id: "ask-first",
        applies: "both",
        text: "Ask before starting a conversation.",
        guidance: "Ask first.",
      },
    ]);
    const configuration = yield* options(path);
    yield* withDaemonStore(stateDirectory(), () =>
      Effect.gen(function* () {
        const installed = yield* makeFirewall(configuration);
        const read = yield* installed.readPolicy();
        expect(read.fixedRules).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: FIXED.id }),
            expect.objectContaining({ id: "working-hours" }),
          ]),
        );
        expect(read.rules).toMatchObject(policy.text?.initialRules ?? []);
        const error = yield* installed
          .updatePolicy({ remove: ["working-hours"] })
          .pipe(Effect.flip);
        expect(error).toMatchObject({
          reason: "fixed-rule",
          ruleId: "working-hours",
          path: ["remove", 0],
        });
        expect(yield* installed.readPolicy()).toEqual(read);
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
    yield* withDaemonStore(state, () =>
      Effect.gen(function* () {
        const installed = yield* makeFirewall(first);
        yield* installed.updatePolicy({ remove: [INITIAL.id, "ask-first"] });
      }),
    );
    writeFileSync(
      join(root, "initial", "BEHAVIOR.md"),
      NORM.replace("Ask first.", "Consult the owner first."),
    );
    const next = yield* options(path);
    yield* withDaemonStore(state, () =>
      Effect.gen(function* () {
        const restarted = yield* makeFirewall(next);
        expect((yield* restarted.readPolicy()).rules).toEqual([]);
      }),
    );
    writeFileSync(
      join(root, "initial", "BEHAVIOR.md"),
      "private-invalid-behavior",
    );
    const error = yield* options(path).pipe(Effect.flip);
    expect(error.message).toContain("text.initialBehaviors.0");
  }),
);

it(
  "seeds 255 inline initial rules and one initial behavior",
  Effect.fn(function* () {
    const { path } = seedFixture(255);
    const configuration = yield* options(path);
    yield* withDaemonStore(stateDirectory(), () =>
      Effect.gen(function* () {
        const installed = yield* makeFirewall(configuration);
        expect((yield* installed.readPolicy()).rules).toHaveLength(256);
      }),
    );
  }),
);

it(
  "names the initial behavior that exceeds the editable rule limit",
  Effect.fn(function* () {
    const { path } = seedFixture(256);
    const error = yield* options(path).pipe(Effect.flip);
    expect(error.behaviorReason).toBe("editable-limit");
    expect(error.message).toContain("text.initialBehaviors.0");
  }),
);

it("names the fixed behavior colliding with a stored editable rule", () =>
  Effect.gen(function* () {
    const { path, root } = fixture();
    const state = stateDirectory();
    const configuration = yield* options(path);
    yield* withDaemonStore(
      state,
      Effect.fn(function* () {
        const installed = yield* makeFirewall(configuration);
        yield* installed.updatePolicy({
          add: [{ ...FIXED, id: "new-fixed" }],
        });
      }),
    );
    writeFileSync(
      join(root, "fixed", "BEHAVIOR.md"),
      BEHAVIOR.replace("name: working-hours", "name: new-fixed"),
    );
    const installation = yield* options(path);
    yield* withDaemonStore(
      state,
      Effect.fn(function* () {
        const error = yield* makeFirewall(installation).pipe(Effect.flip);
        const startup = policyInstallationError(
          error,
          installation.behaviorRulePaths,
        );
        expect(error.reason).toBe("fixed-rule");
        expect(startup.message).toContain(
          "invalid at text.fixedBehaviors.0 (duplicate-id)",
        );
        expect(startup.message).toContain("Docs:");
        expect(startup.behaviorReason).toBe("duplicate-id");
      }),
    );
  }));

it(
  "adds a shared norm's BEHAVIOR.md text as the rule its frontmatter and body map to",
  Effect.fn(function* () {
    const configuration = yield* options(fixture().path);
    yield* withDaemonStore(stateDirectory(), () =>
      Effect.gen(function* () {
        const installed = yield* makeFirewall(configuration);
        yield* installed.updatePolicy({ add: [{ behavior: SHARED }] });
        expect((yield* installed.readPolicy()).rules).toContainEqual({
          id: "meeting-booking",
          applies: "both",
          text: "Each member holds a slot before confirming it.",
          guidance: "Hold a slot before you confirm one.",
          feedback: { text: "Hold the slot first.", nextAction: "revise" },
        });
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
      add: [
        {
          behavior: SHARED.replace("    applies: both\n", ""),
        },
      ],
    },
    refusal: { reason: "invalid-rule", problem: "schema", path: ["add", 0] },
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
    return yield* withDaemonStore(stateDirectory(), () =>
      Effect.gen(function* () {
        const installed = yield* makeFirewall(configuration);
        const before = yield* installed.readPolicy();
        const error = yield* installed.updatePolicy(edit).pipe(Effect.flip);
        return { error, before, after: yield* installed.readPolicy() };
      }),
    );
  });
}

it("persists replacement of an initial rule across restart", () =>
  Effect.gen(function* () {
    const configuration = yield* options(fixture().path);
    const directory = stateDirectory();
    const replacement = { ...INITIAL, text: "Ask before booking a meeting." };
    const read = yield* replaceAndReopen(directory, configuration, replacement);
    expect(read.rules).toContainEqual(replacement);
  }));
function replaceAndReopen(
  directory: string,
  configuration: Parameters<typeof makeFirewall>[0],
  replacement: Omit<typeof INITIAL, "text"> & { readonly text: string },
) {
  return Effect.gen(function* () {
    yield* withDaemonStore(directory, () =>
      Effect.gen(function* () {
        const installed = yield* makeFirewall(configuration);
        yield* installed.updatePolicy({
          remove: [INITIAL.id],
          add: [replacement],
        });
      }),
    );
    return yield* withDaemonStore(directory, () =>
      Effect.gen(function* () {
        const reopened = yield* makeFirewall(configuration);
        return yield* reopened.readPolicy();
      }),
    );
  });
}
/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore defaults after policy edit contract assertions. */
