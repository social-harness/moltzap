/** @file Operator snapshots preserve real retained rows and fail without completion. */

import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { scopedLive as it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { join } from "node:path";
import { describe, expect } from "vitest";
import type { Daemon } from "../../daemon/index.js";
import { digest } from "../../__tests__/agent-card-fixtures.js";
import {
  decodeAudit,
  makeAuditFixture,
} from "../../__tests__/firewall-audit-fixtures.js";
import {
  stateDirectory,
  withStore,
} from "../../__tests__/store-schema-fixtures.js";
import {
  DeliveryToken,
  encodeRuntimeValue,
  type EndpointStore,
  EndpointStoreError,
  openEndpointStore,
} from "../../communication/store/index.js";
import { LIVE_WIRE_VERSIONS } from "../../identity/wire-version.js";
import { MessageContext } from "../evaluator/index.js";
import { installFirewall } from "../index.js";
import { beginFirewallAudit } from "./firewall-audit.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Audit disposition, closed failure reasons, and private file permissions are the contract being tested. */

type AuditFixture = Effect.Effect.Success<typeof makeAuditFixture>;
const RETAINED_CHECKS = 72;
const readAudit = (path: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.readFileString(path)),
    Effect.map(decodeAudit),
  );

function seedIncoming(
  store: EndpointStore,
  fixture: AuditFixture,
  index: number,
  stale: boolean,
) {
  return Effect.gen(function* () {
    const item = {
      deliveryToken: Schema.decodeUnknownSync(DeliveryToken)(
        digest("dlv_", index),
      ),
      canonicalItem: fixture.canonicalIncomingCandidate,
    };
    yield* store.queueFirewallItem({
      ...item,
      conversation: `conversation-${index}`,
    });
    const { revision } = yield* store.readFirewallEvidence({
      maximumRecords: 10,
    });
    const checkId = `check-${index}`;
    yield* store.beginFirewallAttempt({
      ...fixture,
      canonicalCandidate: fixture.canonicalIncomingCandidate,
      checkId,
      direction: "incoming",
      revision,
    });
    if (stale) {
      yield* store.putInboxItem({
        ...item,
        deliveryToken: Schema.decodeUnknownSync(DeliveryToken)(
          digest("dlv_", 240),
        ),
      });
    }
    return yield* store.admitFirewallItem(item, {
      checkId,
      admit: true,
      canonicalResult: fixture.canonicalResult,
    });
  });
}

function seedRetainedAttempts(store: EndpointStore, fixture: AuditFixture) {
  return Effect.gen(function* () {
    for (let index = 0; index < RETAINED_CHECKS - 2; index += 1) {
      const checkId = `check-${index}`;
      yield* store.beginFirewallAttempt({
        ...fixture,
        checkId,
        direction: "outgoing",
        revision: 0,
      });
      if (index > 0) {
        yield* store.admitFirewallOperation(
          {
            checkId,
            admit: index % 2 === 0,
            canonicalResult: fixture.canonicalResult,
          },
          fixture.canonicalCandidate,
        );
      }
    }
    expect(yield* seedIncoming(store, fixture, 70, false)).toBe("admitted");
    expect(yield* seedIncoming(store, fixture, 71, true)).toBe("stale");
  });
}

function expectRetainedChecks(
  snapshot: ReturnType<typeof decodeAudit>,
  fixture: AuditFixture,
) {
  const { records, sha256 } = snapshot;
  const checks = records.filter((record) => record.kind === "check");
  const ids = Array.from({ length: RETAINED_CHECKS }).map(
    (...[, index]) => `check-${index}`,
  );
  expect(checks.map((entry) => entry.checkId)).toEqual(ids);
  expect(checks[0]).toMatchObject({ disposition: "checking", result: null });
  expect(checks[1]).toMatchObject({
    disposition: "withheld",
    input: fixture.input,
    result: fixture.result,
    candidate: fixture.canonicalCandidate,
    post: fixture.post,
  });
  expect(checks[2]?.disposition).toBe("admitted");
  expect(checks[70]).toMatchObject({
    disposition: "admitted",
    result: { judgment: "block" },
    post: fixture.post,
  });
  expect(checks[71]?.disposition).toBe("stale");
  const start = records[0];
  expect(records.at(-1)).toMatchObject({
    kind: "complete",
    checkCount: checks.length,
    sha256,
    snapshotId: start?.kind === "start" ? start.snapshotId : undefined,
  });
}

const snapshotRetainedAttempts = () =>
  Effect.gen(function* () {
    const directory = stateDirectory();
    const path = join(directory, "audit.ndjson");
    const fixture = yield* makeAuditFixture;
    const store = yield* openEndpointStore(directory, {
      liveWireVersions: LIVE_WIRE_VERSIONS,
    });
    const audit = yield* beginFirewallAudit(path, store);
    yield* seedRetainedAttempts(store, fixture);
    const first = yield* store.readFirewallAuditPage(0);
    expect(first.length).toBeLessThan(RETAINED_CHECKS);
    expect((yield* Effect.flip(store.readFirewallAuditPage(-1))).reason).toBe(
      "invalid-input",
    );
    yield* audit.finish;
    expectRetainedChecks(yield* readAudit(path), fixture);
    const fileSystem = yield* FileSystem.FileSystem;
    expect((yield* fileSystem.stat(path)).mode & 0o777).toBe(0o600);
  }).pipe(Effect.provide(NodeFileSystem.layer));

const restartInvalidatesCompletion = () =>
  Effect.gen(function* () {
    const directory = stateDirectory();
    const path = join(directory, "audit.ndjson");
    const fixture = yield* makeAuditFixture;
    yield* withStore(directory, (store) =>
      Effect.gen(function* () {
        yield* store.beginFirewallAttempt({
          ...fixture,
          checkId: "unfinished",
          direction: "outgoing",
          revision: 0,
        });
        yield* (yield* beginFirewallAudit(path, store)).finish;
      }),
    );
    const prior = (yield* readAudit(path)).records[0];
    const store = yield* openEndpointStore(directory, {
      liveWireVersions: LIVE_WIRE_VERSIONS,
    });
    const audit = yield* beginFirewallAudit(path, store);
    const current = (yield* readAudit(path)).records;
    expect(current.map((entry) => entry.kind)).toEqual(["start"]);
    expect(current[0]).not.toEqual(prior);
    yield* audit.finish;
    expect((yield* readAudit(path)).records[1]).toMatchObject({
      checkId: "unfinished",
      disposition: "interrupted",
      result: null,
    });
  }).pipe(Effect.provide(NodeFileSystem.layer));

const refusesUnsafePaths = () =>
  Effect.gen(function* () {
    const directory = stateDirectory();
    const store = yield* openEndpointStore(directory, {
      liveWireVersions: LIVE_WIRE_VERSIONS,
    });
    const fileSystem = yield* FileSystem.FileSystem;
    const target = join(directory, "target");
    const link = join(directory, "link");
    const contents = "keep this file";
    yield* fileSystem.writeFileString(target, contents);
    yield* fileSystem.symlink(target, link);
    expect((yield* Effect.flip(beginFirewallAudit(link, store))).reason).toBe(
      "path",
    );
    expect(yield* fileSystem.readFileString(target)).toBe(contents);
    expect(
      (yield* Effect.flip(beginFirewallAudit("relative.ndjson", store))).reason,
    ).toBe("path");
    const publicDirectory = join(directory, "shared");
    yield* fileSystem.makeDirectory(publicDirectory);
    // eslint-disable-next-line sonarjs/file-permissions -- The empty shared directory is deliberately rejected by the audit writer.
    yield* fileSystem.chmod(publicDirectory, 0o755);
    expect(
      (yield* Effect.flip(
        beginFirewallAudit(join(publicDirectory, "audit"), store),
      )).reason,
    ).toBe("path");
    const alias = join(directory, "alias");
    yield* fileSystem.symlink(directory, alias);
    expect(
      (yield* Effect.flip(beginFirewallAudit(join(alias, "audit"), store)))
        .reason,
    ).toBe("path");
    expect(
      (yield* Effect.flip(beginFirewallAudit(publicDirectory, store))).reason,
    ).toBe("path");
  }).pipe(Effect.provide(NodeFileSystem.layer));

const failedReadLeavesIncomplete = () =>
  Effect.gen(function* () {
    const directory = stateDirectory();
    const path = join(directory, "audit.ndjson");
    const fixture = yield* makeAuditFixture;
    const store = yield* openEndpointStore(directory, {
      liveWireVersions: LIVE_WIRE_VERSIONS,
    });
    yield* store.beginFirewallAttempt({
      ...fixture,
      checkId: "one",
      direction: "outgoing",
      revision: 0,
    });
    const audit = yield* beginFirewallAudit(path, {
      readFirewallActivations: store.readFirewallActivations,
      readFirewallAuditPage: (after) =>
        after === 0
          ? store.readFirewallAuditPage(after)
          : Effect.fail(new EndpointStoreError({ reason: "persistence" })),
    });
    expect((yield* Effect.flip(audit.finish)).reason).toBe("records");
    expect((yield* readAudit(path)).records.map((entry) => entry.kind)).toEqual(
      ["start"],
    );
    const fileSystem = yield* FileSystem.FileSystem;
    expect(
      (yield* fileSystem.readDirectory(directory)).filter((name) =>
        name.endsWith(".partial"),
      ),
    ).toEqual([]);
  }).pipe(Effect.provide(NodeFileSystem.layer));

const failedPublicationLeavesIncomplete = () =>
  Effect.gen(function* () {
    const directory = stateDirectory();
    const path = join(directory, "audit.ndjson");
    const fileSystem = yield* FileSystem.FileSystem;
    const store = yield* openEndpointStore(directory, {
      liveWireVersions: LIVE_WIRE_VERSIONS,
    });
    const audit = yield* beginFirewallAudit(path, {
      readFirewallActivations: store.readFirewallActivations,
      readFirewallAuditPage: (after) =>
        fileSystem
          .chmod(directory, 0o500)
          .pipe(
            Effect.orDie,
            Effect.zipRight(store.readFirewallAuditPage(after)),
          ),
    });
    yield* Effect.gen(function* () {
      expect((yield* Effect.flip(audit.finish)).reason).toBe("persistence");
    }).pipe(
      Effect.ensuring(fileSystem.chmod(directory, 0o700).pipe(Effect.orDie)),
    );
    expect((yield* readAudit(path)).records.map((entry) => entry.kind)).toEqual(
      ["start"],
    );
  }).pipe(Effect.provide(NodeFileSystem.layer));

const corruptAttemptLeavesIncomplete = (
  encoding: "malformed" | "unknown-field",
) =>
  Effect.gen(function* () {
    const directory = stateDirectory();
    const path = join(directory, "audit.ndjson");
    const fixture = yield* makeAuditFixture;
    const store = yield* openEndpointStore(directory, {
      liveWireVersions: LIVE_WIRE_VERSIONS,
    });
    yield* store.beginFirewallAttempt({
      ...fixture,
      canonicalInput:
        encoding === "malformed"
          ? new TextEncoder().encode("invalid")
          : yield* encodeRuntimeValue({
              ...fixture.input,
              context: {
                ...(yield* Schema.encode(MessageContext)(
                  fixture.input.context,
                )),
                unknown: "cannot drop this",
              },
            }),
      checkId: "corrupt",
      direction: "outgoing",
      revision: 0,
    });
    const audit = yield* beginFirewallAudit(path, store);
    expect((yield* Effect.flip(audit.finish)).reason).toBe("records");
    expect((yield* readAudit(path)).records.map((entry) => entry.kind)).toEqual(
      ["start"],
    );
  }).pipe(Effect.provide(NodeFileSystem.layer));

const auditPathDoesNotChangePolicy = () =>
  Effect.gen(function* () {
    const fixture = yield* makeAuditFixture;
    const options: Daemon.FirewallOptions = {
      ...fixture.options,
      auditExport: "/operator/audit.ndjson",
    };
    const installed = yield* installFirewall(options);
    expect(installed.configurationDigest).toBe(
      fixture.input.configurationDigest,
    );
    expect(installed.metadata).toEqual(fixture.input.installation);
  });

describe("firewall audit export", () => {
  it(
    "exports every retained attempt across pages with private traces and a verifiable footer",
    snapshotRetainedAttempts,
  );
  it(
    "invalidates old completion and retains interrupted checks across restart",
    restartInvalidatesCompletion,
  );
  it(
    "refuses symlinks, shared directories, non-files and relative paths",
    refusesUnsafePaths,
  );
  it(
    "keeps the incomplete marker when a later store page fails",
    failedReadLeavesIncomplete,
  );
  it(
    "does not publish completion when atomic replacement fails",
    failedPublicationLeavesIncomplete,
  );
  it("does not omit a corrupt retained attempt", () =>
    corruptAttemptLeavesIncomplete("malformed"));
  it("does not discard unrecognized retained fields", () =>
    corruptAttemptLeavesIncomplete("unknown-field"));
  it(
    "keeps the audit destination outside policy identity",
    auditPathDoesNotChangePolicy,
  );
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore defaults after the audit contract assertions. */
