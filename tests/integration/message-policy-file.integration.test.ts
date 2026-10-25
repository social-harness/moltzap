/**
 * @file Stock `sharnessd` installs the firewall its message-policy file
 * describes: the owner tools list the document's rules, a send its code
 * rules refuse returns the refusal while an ordinary send certifies, the
 * audit is published on graceful shutdown, and an invalid document stops
 * startup naming the setting.
 */

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Effect, Schedule, Schema } from "effect";
import { FirewallAuditRecord } from "@moltzap/client/service";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  stopProcess,
} from "./daemon-process-harness.js";

const FORMAT = "org.social-harness/message-policy/v1";

const CREDENTIAL = "sk-proj-integrationCredential1234";

const fixedRulesSchema = Schema.Struct({
  fixedRules: Schema.Array(
    Schema.Struct({ from: Schema.String, id: Schema.String }),
  ),
});

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

const enforcedCodeRules = Effect.gen(function* () {
  const infrastructure = yield* acquireProcessInfrastructure;
  const bob = yield* makeDaemonProcessFixture(infrastructure, "bob");
  yield* acquireDaemonProcess(bob);
  const bobManagement = yield* acquireDaemonManagementClient(bob.endpoint);
  yield* bobManagement.register(makeRegistrationRequest(bob));

  const stock = yield* makeDaemonProcessFixture(infrastructure, "alice");
  const directory = join(infrastructure.temporaryDirectory, "alice-policy");
  const exports = join(directory, "exports");
  yield* Effect.promise(() => mkdir(exports, { recursive: true, mode: 0o700 }));
  const policyFile = join(directory, "message-policy.json");
  yield* Effect.promise(() =>
    writeFile(
      policyFile,
      JSON.stringify({
        format: FORMAT,
        mode: "enforcement",
        incoming: [{ use: "acknowledgements" }],
        outgoing: [{ use: "credentials" }],
      }),
      { mode: 0o600 },
    ),
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

  const policy = yield* call(client, "policy_read").pipe(
    Effect.flatMap(Schema.decodeUnknown(fixedRulesSchema)),
    Effect.retry(
      Schedule.intersect(Schedule.spaced("25 millis"), Schedule.recurs(200)),
    ),
  );
  expect(policy.fixedRules).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ from: "code", id: "credentials" }),
      expect.objectContaining({ from: "code", id: "acknowledgement" }),
    ]),
  );

  const refused = yield* call(client, "send_message", {
    input: { to: "agent:bob", text: `my key is ${CREDENTIAL}` },
  }).pipe(Effect.flip);
  expect(JSON.stringify(refused)).toContain("Remove credential-shaped text");
  yield* call(client, "send_message", {
    input: { to: "agent:bob", text: "See you on Tuesday." },
  });

  yield* stopProcess(daemon);
  const records = yield* Effect.forEach(
    (yield* Effect.promise(() => readFile(auditExport, "utf8")))
      .trim()
      .split("\n"),
    (line) => Schema.decodeUnknown(Schema.parseJson(FirewallAuditRecord))(line),
  );
  expect(records.at(0)?.kind).toBe("start");
  expect(records.at(-1)?.kind).toBe("complete");
  expect(records.filter((record) => record.kind === "check")).toHaveLength(2);
});

const invalidDocument = Effect.gen(function* () {
  const infrastructure = yield* acquireProcessInfrastructure;
  const stock = yield* makeDaemonProcessFixture(infrastructure, "carol");
  const policyFile = join(infrastructure.temporaryDirectory, "carol.json");
  yield* Effect.promise(() =>
    writeFile(policyFile, JSON.stringify({ format: FORMAT, mode: "off" }), {
      mode: 0o600,
    }),
  );
  const failure = yield* awaitDaemonStartupFailure(
    withPolicy(stock, { SHARNESS_MESSAGE_POLICY_FILE: policyFile }),
  );
  expect(failure.exitCode).not.toBe(0);
  expect(failure.logs).toContain("SHARNESS_MESSAGE_POLICY_FILE");
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
