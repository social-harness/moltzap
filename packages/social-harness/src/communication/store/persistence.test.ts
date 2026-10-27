/** @file Transaction failures retain whether a mutation can have committed. */

import { scopedLive as it } from "@effect/vitest";
import { Effect } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect, vi } from "vitest";
import {
  bytes,
  databasePath,
  stateDirectory,
} from "../../__tests__/store-schema-fixtures.js";
import { LIVE_WIRE_VERSIONS } from "../../identity/wire-version.js";
import { openEndpointStore } from "./index.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Closed persistence reasons and absence of injected diagnostic text are the contract under test. */
// @agent-code-guard/regression-only: driver faults pin persistence outcomes and diagnostic redaction through the public store interface.

it.each(["ABORT", "ROLLBACK"] as const)(
  "reports a %s persistence failure without disclosing SQLite values",
  (action) =>
    Effect.gen(function* () {
      const directory = stateDirectory();
      yield* Effect.scoped(
        openEndpointStore(directory, { liveWireVersions: LIVE_WIRE_VERSIONS }),
      );
      const database = new DatabaseSync(databasePath(directory));
      database.exec(`CREATE TRIGGER refuse_identity BEFORE INSERT ON identity_binding
      BEGIN SELECT RAISE(${action}, 'secret SQLite diagnostic'); END`);
      database.close();
      const store = yield* openEndpointStore(directory, {
        liveWireVersions: LIVE_WIRE_VERSIONS,
      });

      const failure = yield* store
        .bindIdentity({
          agentId: "local",
          canonicalAgentCard: bytes("secret card"),
        })
        .pipe(Effect.flip);

      expect(failure).toMatchObject({
        reason: "persistence",
        commitOutcome: "not-committed",
      });
      expect(JSON.stringify(failure)).not.toContain("secret");
      expect(yield* store.readIdentity()).toBeUndefined();
    }),
);

it("reports uncertainty when a persistence failure follows the commit", () =>
  Effect.gen(function* () {
    const store = yield* openEndpointStore(stateDirectory(), {
      liveWireVersions: LIVE_WIRE_VERSIONS,
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The fault injector explicitly calls this driver method with the intercepted database as its receiver.
    const execute = DatabaseSync.prototype.exec;
    const fault = vi
      .spyOn(DatabaseSync.prototype, "exec")
      .mockImplementation(function (this: DatabaseSync, sql) {
        execute.call(this, sql);
        if (sql === "COMMIT") {
          throw new Error("secret commit diagnostic");
        }
      });

    const failure = yield* store
      .bindIdentity({
        agentId: "local",
        canonicalAgentCard: bytes("secret card"),
      })
      .pipe(
        Effect.flip,
        Effect.ensuring(
          Effect.sync(() => {
            fault.mockRestore();
          }),
        ),
      );

    expect(failure).toMatchObject({
      reason: "persistence",
      commitOutcome: undefined,
    });
    expect(JSON.stringify(failure)).not.toContain("secret");
    expect(yield* store.readIdentity()).toMatchObject({ agentId: "local" });
  }));

it("reports no commit when transaction acquisition fails", () =>
  Effect.gen(function* () {
    const store = yield* openEndpointStore(stateDirectory(), {
      liveWireVersions: LIVE_WIRE_VERSIONS,
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The fault injector explicitly calls this driver method with the intercepted database as its receiver.
    const execute = DatabaseSync.prototype.exec;
    const fault = vi
      .spyOn(DatabaseSync.prototype, "exec")
      .mockImplementation(function (this: DatabaseSync, sql) {
        if (sql.startsWith("BEGIN")) {
          throw new Error("secret acquisition diagnostic");
        }
        execute.call(this, sql);
      });
    const failure = yield* store
      .bindIdentity({
        agentId: "local",
        canonicalAgentCard: bytes("secret card"),
      })
      .pipe(
        Effect.flip,
        Effect.ensuring(
          Effect.sync(() => {
            fault.mockRestore();
          }),
        ),
      );
    expect(failure).toMatchObject({
      reason: "persistence",
      commitOutcome: "not-committed",
    });
    expect(JSON.stringify(failure)).not.toContain("secret");
    expect(yield* store.readIdentity()).toBeUndefined();
  }));

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore repository defaults. */
