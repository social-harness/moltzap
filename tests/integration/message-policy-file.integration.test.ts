/**
 * @file Stock `sharnessd` installs the firewall its message-policy file
 * describes: the owner tools list the document's rules, a send its code
 * rules refuse returns the refusal while an ordinary send certifies, the
 * decisions feed reports both checks, and an invalid document stops startup
 * naming the setting.
 */

import { FileSystem } from "@effect/platform";
import {
  Client,
  type ClientOptions,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Effect, Schema } from "effect";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireDaemonManagementClient,
  acquireDaemonProcess,
  acquireProcessInfrastructure,
  awaitDaemonStartupFailure,
  type DaemonProcessFixture,
  makeDaemonProcessFixture,
  makeRegistrationRequest,
} from "./daemon-process-harness.js";
import {
  credentialRefusalRemedy,
  messagePolicyFileSetting,
} from "./expected-contracts.js";
import { processTrace } from "./process-trace.js";
import { arrayContaining, objectContaining } from "./test-matchers.js";

const FORMAT = "org.social-harness/message-policy/v2";

const CURRENT_CLIENT: ClientOptions = {
  versionNegotiation: { mode: { pin: "2026-07-28" } },
};
/**
 * A 2025-11-25 client: the SDK pins only 2026-07-28 and later, so this one
 * runs the `initialize` handshake offering and accepting only 2025-11-25.
 */
const OLDER_CLIENT: ClientOptions = {
  versionNegotiation: { mode: "legacy" },
  supportedProtocolVersions: ["2025-11-25"],
};

const acquirePolicyFileScenario = Effect.gen(function* () {
  const infrastructure = yield* acquireProcessInfrastructure;
  const bob = yield* makeDaemonProcessFixture(infrastructure, "bob");
  yield* acquireDaemonProcess(bob);
  const bobManagement = yield* acquireDaemonManagementClient(bob.endpoint);
  yield* bobManagement.register(makeRegistrationRequest(bob));
  const stock = yield* makeDaemonProcessFixture(infrastructure, "alice");
  const fs = yield* FileSystem.FileSystem;
  const directory = join(infrastructure.temporaryDirectory, "alice-policy");
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  const policyFile = join(directory, "message-policy.json");
  yield* fs.writeFileString(
    policyFile,
    JSON.stringify({
      format: FORMAT,
      mode: "enforcement",
      incoming: [{ use: "acknowledgements" }],
      outgoing: [{ use: "credentials" }],
    }),
    { mode: 0o600 },
  );
  const alice = withPolicy(stock, {
    SHARNESS_MESSAGE_POLICY_FILE: policyFile,
  });
  yield* acquireDaemonProcess(alice);
  const management = yield* acquireDaemonManagementClient(alice.endpoint);
  yield* management.register(makeRegistrationRequest(alice));
  const client = yield* connect(alice.endpoint);
  return { client, endpoint: alice.endpoint };
});

const CREDENTIAL = "sk-proj-integrationCredential1234";

const fixedRulesSchema = Schema.Struct({
  fixedRules: Schema.Array(
    Schema.Struct({ from: Schema.String, id: Schema.String }),
  ),
});

const enforcedCodeRules = Effect.gen(function* () {
  const scenario = yield* acquirePolicyFileScenario;
  yield* expectDocumentRulesPublished(scenario.client);
  yield* expectCredentialSendRefused(scenario.client);
  const feed = yield* call(scenario.client, "firewall_decisions");
  expect(feed).toMatchObject({
    decisions: [
      { direction: "outgoing", outcome: "allow" },
      {
        direction: "outgoing",
        outcome: "reject",
        decidedBy: [{ ruleId: "credentials", from: "code" }],
      },
    ],
  });
});

const olderMcpClient = Effect.gen(function* () {
  const scenario = yield* acquirePolicyFileScenario;
  const client = yield* connect(scenario.endpoint, OLDER_CLIENT);
  const catalog = yield* Effect.tryPromise(() => client.listTools());
  expect(catalog.tools).toEqual(
    arrayContaining([objectContaining({ name: "policy_read" })]),
  );

  const policy = yield* call(client, "policy_read").pipe(
    Effect.flatMap(Schema.decodeUnknown(fixedRulesSchema)),
  );
  expect(policy.fixedRules).toEqual(
    arrayContaining([
      objectContaining({ from: "code", id: "credentials" }),
      objectContaining({ from: "code", id: "acknowledgement" }),
    ]),
  );
});

const invalidDocument = Effect.gen(function* () {
  const infrastructure = yield* acquireProcessInfrastructure;
  const stock = yield* makeDaemonProcessFixture(infrastructure, "carol");
  const fs = yield* FileSystem.FileSystem;
  const policyFile = join(infrastructure.temporaryDirectory, "carol.json");
  yield* fs.writeFileString(
    policyFile,
    JSON.stringify({ format: FORMAT, mode: "off" }),
    {
      mode: 0o600,
    },
  );
  const failure = yield* awaitDaemonStartupFailure(
    withPolicy(stock, { SHARNESS_MESSAGE_POLICY_FILE: policyFile }),
  );
  expect(failure.exitCode).not.toBe(0);
  expect(failure.logs).toContain(messagePolicyFileSetting);
});

describe("stock sharnessd with a message-policy file", () => {
  it(
    "lists tools and reads policy with an MCP 2025-11-25 client",
    processTrace(olderMcpClient.pipe(Effect.scoped)),
    60_000,
  );

  it(
    "enforces the document's code rules",
    processTrace(enforcedCodeRules.pipe(Effect.scoped)),
    60_000,
  );

  it(
    "stops startup on an invalid document",
    processTrace(invalidDocument.pipe(Effect.scoped)),
    60_000,
  );
});

function expectDocumentRulesPublished(client: Client) {
  return Effect.gen(function* () {
    const policy = yield* call(client, "policy_read").pipe(
      Effect.flatMap(Schema.decodeUnknown(fixedRulesSchema)),
    );
    expect(policy.fixedRules).toEqual(
      arrayContaining([
        objectContaining({ from: "code", id: "credentials" }),
        objectContaining({ from: "code", id: "acknowledgement" }),
      ]),
    );
  });
}

function expectCredentialSendRefused(client: Client) {
  return Effect.gen(function* () {
    const refused = yield* call(client, "send_message", {
      input: { to: "agent:bob", text: `my key is ${CREDENTIAL}` },
    }).pipe(Effect.flip);
    expect(JSON.stringify(refused)).toContain(credentialRefusalRemedy);
    yield* call(client, "send_message", {
      input: { to: "agent:bob", text: "See you on Tuesday." },
    });
  });
}

/** The fixture with its message-policy settings added to its environment. */
function withPolicy(
  fixture: DaemonProcessFixture,
  settings: Readonly<Record<string, string>>,
): DaemonProcessFixture {
  return {
    ...fixture,
    environment: { ...fixture.environment, ...settings },
  };
}

function connect(endpoint: URL, negotiation = CURRENT_CLIENT) {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const client = new Client(
        { name: "message-policy-file", version: "1" },
        { capabilities: {}, ...negotiation },
      );
      yield* Effect.tryPromise(() =>
        client.connect(new StreamableHTTPClientTransport(endpoint)),
      );
      return client;
    }),
    (client) => Effect.tryPromise(() => client.close()).pipe(Effect.ignore),
  );
}

function call(
  client: Client,
  name: string,
  args: Readonly<Record<string, unknown>> = {},
) {
  return Effect.tryPromise(() =>
    client.callTool({ name, arguments: args }),
  ).pipe(
    Effect.filterOrFail(
      (result) => result.isError !== true,
      (result) => result,
    ),
    Effect.map((result) => result.structuredContent),
  );
}
