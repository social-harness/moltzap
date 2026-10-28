/** @file Behaviors Client ships install by name from the installed package as readable English policy. */

import { live as it } from "@effect/vitest";
import { Effect } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Tests read the published behavior files and write an owner policy document.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import {
  stateDirectory,
  withStore,
} from "../../__tests__/store-schema-fixtures.js";
import { readCredential } from "../../daemon/credentials.js";
import { firewallInstallation, installEditableFirewall } from "./index.js";

const BEHAVIORS = [
  { name: "collectives/one-gather", kind: "norm" },
  { name: "collectives/announce-once", kind: "norm" },
  { name: "collectives/result-settles", kind: "norm" },
  { name: "collectives/empty-acknowledgement", kind: "norm" },
  { name: "collectives/facilitator", kind: "norm" },
  { name: "policy/no-policy-changes", kind: "safety" },
];
const SOURCE = fileURLToPath(new URL("../../../behaviors", import.meta.url));

it(
  "installs every shipped behavior named in builtinBehaviors and lists its full text in policy_read",
  Effect.fn(function* () {
    const installation = yield* firewallInstallation(
      { messagePolicyFile: writePolicy() },
      readCredential,
    );
    const options = yield* Effect.fromNullable(installation.options);
    yield* withStore(stateDirectory(), (store) =>
      Effect.gen(function* () {
        const installed = yield* installEditableFirewall(options, store);
        const policy = yield* installed.policy.read();
        for (const { name, kind } of BEHAVIORS) {
          const source = readFileSync(join(SOURCE, name, "BEHAVIOR.md"), "utf8");
          const text = source
            .split(/^---\s*$/mu)
            .at(-1)
            ?.trim();
          expect(text).toBeTruthy();
          expect(policy.fixedRules).toContainEqual(
            expect.objectContaining({
              from: "english",
              id: name.split("/")[1],
              kind,
              text,
            }),
          );
        }
      }),
    );
  }),
);

function writePolicy() {
  const path = join(stateDirectory(), "message-policy.json");
  writeFileSync(
    path,
    JSON.stringify({
      format: "org.social-harness/message-policy/v1",
      mode: "guidance",
      outgoing: [{ use: "open-requests" }, { use: "acknowledgements" }],
      incoming: [{ use: "acknowledgements" }],
      decisionProvider: { kind: "unavailable" },
      english: {
        builtinBehaviors: BEHAVIORS.map(({ name }) => name),
      },
      facts: [
        {
          id: "facilitator",
          source: "owner",
          text: "For this conversation, AgentId agt_AAAAAAAAAAAAAAAAAAAAAA is the facilitator.",
          visibility: "assessor",
        },
      ],
    }),
  );
  return path;
}
