/** @file Behaviors Client ships install by name from the installed package as readable English policy, and are the collective-norms bundle's English norms. */

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
import {
  decodeMessagePolicy,
  firewallInstallation,
  installEditableFirewall,
  messagePolicyFirewall,
} from "./index.js";

const SOURCE = fileURLToPath(new URL("../../../behaviors", import.meta.url));
const BEHAVIORS = readdirSync(SOURCE).flatMap((pack) =>
  readdirSync(join(SOURCE, pack)).map((name) => `${pack}/${name}`),
);
/** Each shipped collective norm and the id the collective-norms bundle registers it under. */
const BUNDLE_NORMS = [
  ["one-gather", "one-gather"],
  ["announce-once", "announce-once"],
  ["result-settles", "result-settles"],
  ["empty-acknowledgement", "acknowledgement"],
] as const;

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
              from: "english",
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

it(
  "registers the shipped collective norms' guidance and feedback in the collective-norms bundle",
  Effect.fn(function* () {
    const installation = yield* firewallInstallation(
      { messagePolicyFile: writePolicy() },
      readCredential,
    );
    const options = yield* Effect.fromNullable(installation.options);
    const shipped = options.english?.fixedRules ?? [];
    const policy = yield* decodeMessagePolicy(
      JSON.stringify({
        format: "org.social-harness/message-policy/v1",
        mode: "guidance",
        incoming: [{ use: "collective-norms" }],
        outgoing: [{ use: "collective-norms", facilitator: false }],
        decisionProvider: { kind: "jev", model: "jev-1.13.0" },
      }),
    );
    const bundle = yield* messagePolicyFirewall(policy, {
      decide: () => Effect.die("no assessment requested"),
    });
    const registered = [...bundle.incoming, ...bundle.outgoing].flatMap(
      (middleware) => middleware.rules,
    );
    for (const [shippedId, bundleId] of BUNDLE_NORMS) {
      const rule = shipped.find(({ id }) => id === shippedId);
      expect(rule).toBeDefined();
      expect(registered).toContainEqual(
        expect.objectContaining({
          id: bundleId,
          kind: rule?.kind,
          guidance: rule?.guidance,
          feedback: rule?.feedback,
        }),
      );
    }
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
