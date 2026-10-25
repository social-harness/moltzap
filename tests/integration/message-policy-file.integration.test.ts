/**
 * @file Stock `sharnessd` installs the firewall its message-policy file
 * describes: the owner tools list the document's rules, a send its code
 * rules refuse returns the refusal while an ordinary send certifies, the
 * audit is published on graceful shutdown, and an invalid document stops
 * startup naming the setting.
 */

import { FileSystem } from "@effect/platform";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { FirewallAuditRecord } from "@moltzap/client/service";
import { Effect, Schedule, Schema } from "effect";
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
  processTrace,
  type RunningProcess,
  stopProcess,
} from "./daemon-process-harness.js";
import {
  auditCompleteKind,
  auditStartKind,
  credentialRefusalRemedy,
  messagePolicyFileSetting,
} from "./expected-contracts.js";
import { arrayContaining, objectContaining } from "./test-matchers.js";

const FORMAT = "org.social-harness/message-policy/v1";

const acquirePolicyFileScenario = Effect.gen(function* () {
  const infrastructure = yield* acquireProcessInfrastructure;
  const bob = yield* makeDaemonProcessFixture(infrastructure, "bob");
  yield* acquireDaemonProcess(bob);
  const bobManagement = yield* acquireDaemonManagementClient(bob.endpoint);
  yield* bobManagement.register(makeRegistrationRequest(bob));
  const stock = yield* makeDaemonProcessFixture(infrastructure, "alice");
  const fs = yield* FileSystem.FileSystem;
  const directory = join(infrastructure.temporaryDirectory, "alice-policy");
  const exports = join(directory, "exports");
  yield* fs.makeDirectory(exports, { recursive: true, mode: 0o700 });
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
  const auditExport = join(exports, "firewall.ndjson");
  const alice = withPolicy(stock, {
    SHARNESS_MESSAGE_POLICY_FILE: policyFile,
    SHARNESS_FIREWALL_AUDIT_EXPORT: auditExport,
  });
  const daemon = yield* acquireDaemonProcess(alice);
  const management = yield* acquireDaemonManagementClient(alice.endpoint);
  yield* management.register(makeRegistrationRequest(alice));
  const client = yield* connect(alice.endpoint);
  return { bob, auditExport, daemon, client };
});

const CREDENTIAL = "sk-proj-integrationCredential1234";

const fixedRulesSchema = Schema.Struct({
  fixedRules: Schema.Array(
    Schema.Struct({ from: Schema.String, id: Schema.String }),
  ),
});

interface PolicyFileScenario {
  readonly auditExport: string;
  readonly daemon: RunningProcess;
  readonly client: Client;
}

const enforcedCodeRules = Effect.gen(function* () {
  const scenario = yield* acquirePolicyFileScenario;
  yield* expectDocumentRulesPublished(scenario.client);
  yield* expectCredentialSendRefused(scenario.client);
  yield* expectAuditPublishedOnShutdown(scenario);
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
    "enforces the document's code rules and publishes the audit",
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
      Effect.retry(
        Schedule.intersect(Schedule.spaced("25 millis"), Schedule.recurs(200)),
      ),
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

function expectAuditPublishedOnShutdown({
  auditExport,
  daemon,
}: PolicyFileScenario) {
  return Effect.gen(function* () {
    yield* stopProcess(daemon);
    const records = yield* Effect.forEach(
      (yield* (yield* FileSystem.FileSystem).readFileString(auditExport))
        .trim()
        .split("\n"),
      (line) =>
        Schema.decodeUnknown(Schema.parseJson(FirewallAuditRecord))(line),
      { concurrency: 1 },
    );
    expect(records.at(0)?.kind).toBe(auditStartKind);
    expect(records.at(-1)?.kind).toBe(auditCompleteKind);
    expect(records.filter((record) => record.kind === "check")).toHaveLength(2);
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

function connect(endpoint: URL) {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const client = new Client(
        { name: "message-policy-file", version: "1" },
        {
          capabilities: {},
          versionNegotiation: { mode: { pin: "2026-07-28" } },
        },
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
