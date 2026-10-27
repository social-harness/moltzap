/** @file Shipped collective behaviors install through owner documents as readable English policy. */

import { live as it } from "@effect/vitest";
import { Effect } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Tests stage the published behavior directories beside an owner policy document.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  "one-gather",
  "announce-once",
  "result-settles",
  "empty-acknowledgement",
  "facilitator",
];
const SOURCE = fileURLToPath(
  new URL("../../../behaviors/collectives", import.meta.url),
);

it(
  "loads shipped behaviors from a document and lists their full text in policy_read",
  Effect.fn(function* () {
    const path = stagePolicy();
    const installation = yield* firewallInstallation(
      { messagePolicyFile: path },
      readCredential,
    );
    const options = yield* Effect.fromNullable(installation.options);
    yield* withStore(stateDirectory(), (store) =>
      Effect.gen(function* () {
        const installed = yield* installEditableFirewall(options, store);
        const policy = yield* installed.policy.read();
        for (const id of BEHAVIORS) {
          const source = readFileSync(join(SOURCE, id, "BEHAVIOR.md"), "utf8");
          const text = source
            .split(/^---\s*$/mu)
            .at(-1)
            ?.trim();
          expect(text).toBeTruthy();
          expect(policy.fixedRules).toContainEqual(
            expect.objectContaining({
              from: "english",
              id,
              kind: "norm",
              text,
            }),
          );
        }
      }),
    );
  }),
);

function stagePolicy() {
  const root = stateDirectory();
  const directory =
    "node_modules/@moltzap/social-harness/behaviors/collectives";
  mkdirSync(join(root, directory), { recursive: true });
  cpSync(SOURCE, join(root, directory), { recursive: true });
  const path = join(root, "message-policy.json");
  writeFileSync(
    path,
    JSON.stringify({
      format: "org.social-harness/message-policy/v1",
      mode: "guidance",
      outgoing: [{ use: "open-requests" }, { use: "acknowledgements" }],
      incoming: [{ use: "acknowledgements" }],
      decisionProvider: { kind: "unavailable" },
      english: {
        fixedBehaviors: BEHAVIORS.map((id) => `${directory}/${id}`),
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
