/** @file Behaviors Client ships install by name from the installed package as readable natural-language policy. */

import { live as it } from "@effect/vitest";
import { Effect } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Tests read the published behavior files and write an owner policy document.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import {
  stateDirectory,
  withStore,
} from "../../__tests__/store-schema-fixtures.js";
import { readCredential } from "../../daemon/credentials.js";
import { firewallInstallation, installEditableFirewall } from "./index.js";

const SOURCE = fileURLToPath(new URL("../../../behaviors", import.meta.url));
const BEHAVIORS = readdirSync(SOURCE).flatMap((pack) =>
  readdirSync(join(SOURCE, pack)).map((name) => `${pack}/${name}`),
);

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
        for (const name of BEHAVIORS) {
          const source = readFileSync(
            join(SOURCE, name, "BEHAVIOR.md"),
            "utf8",
          );
          const text = source
            .split(/^---\s*$/mu)
            .at(-1)
            ?.trim();
          expect(text).toBeTruthy();
          expect(policy.fixedRules).toContainEqual(
            expect.objectContaining({
              from: "text",
              id: name.split("/")[1],
              kind: /kind: (\w+)/u.exec(source)?.[1],
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
      format: "org.social-harness/message-policy/v2",
      mode: "guidance",
      outgoing: [{ use: "open-requests" }, { use: "acknowledgements" }],
      incoming: [{ use: "acknowledgements" }],
      decisionProvider: { kind: "unavailable" },
      text: {
        builtinBehaviors: BEHAVIORS,
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
