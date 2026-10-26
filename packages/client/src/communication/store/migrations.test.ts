/** @file Migration admission, atomic rollback, replaceable backups, and retained history. */

import { live as it } from "@effect/vitest";
import { Effect, Exit } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- These tests exercise real SQLite files and directory permissions at the synchronous ownership boundary.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect } from "vitest";
import {
  buildCertifiedGenesis,
  storeCertifiedGenesis,
} from "../../__tests__/certified-history-fixtures.js";
import { fixture } from "../../__tests__/firewall-runtime-fixtures.js";
import { routerInstanceId } from "../../__tests__/router-worker-fixtures.js";
import {
  databasePath,
  stateDirectory,
  storedConversation,
  withStore,
} from "../../__tests__/store-schema-fixtures.js";
import { LIVE_WIRE_VERSIONS } from "../../identity/wire-version.js";
import { readStoredHistory } from "../conversations/index.js";
import { RESET_SCHEMA } from "./database/migrations.js";
import { closeStoreState, openStoreState } from "./database/schema.js";
import { type EndpointStore, openEndpointStore } from "./index.js";

const steps: Record<number, (database: DatabaseSync) => void> = {};
const storeOptions = {
  liveWireVersions: LIVE_WIRE_VERSIONS,
  migrations: steps,
};

afterEach(() => {
  for (const key of Object.keys(steps)) {
    Reflect.deleteProperty(steps, key);
  }
});

function version(path: string): number {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database.prepare("PRAGMA user_version").get();
    if (typeof row?.user_version !== "number") {
      throw new Error("missing schema version");
    }
    return row.user_version;
  } finally {
    database.close();
  }
}

function addMarker(database: DatabaseSync): void {
  database.exec(
    "CREATE TABLE migration_marker (value TEXT); INSERT INTO migration_marker VALUES ('committed')",
  );
}

function openAndClose(
  directory: string,
  liveWireVersions: readonly string[] = LIVE_WIRE_VERSIONS,
) {
  return Effect.acquireUseRelease(
    openStoreState(directory, { liveWireVersions, migrations: steps }),
    () => Effect.void,
    closeStoreState,
  );
}

function prepare() {
  return Effect.gen(function* () {
    const directory = stateDirectory();
    yield* openAndClose(directory);
    const path = databasePath(directory);
    const from = version(path);
    return { directory, path, from, backup: `${path}.schema-${from}.backup` };
  });
}

// @agent-code-guard/regression-only: real SQLite failure fixtures pin upgrade admission, rollback, backup publication and ownership.

it("preserves history through a synthetic next-version step and writes a private backup", () =>
  Effect.gen(function* () {
    const history = yield* Effect.scoped(
      Effect.gen(function* () {
        const subject = yield* fixture;
        const record = yield* buildCertifiedGenesis(
          subject.local,
          subject.remote,
          subject.membership,
          routerInstanceId(8),
        );
        yield* storeCertifiedGenesis(
          subject.store,
          subject.local.card,
          subject.membership,
          record,
        );
        return { directory: subject.directory, signer: subject.signer, record };
      }),
    );
    const path = databasePath(history.directory);
    const from = version(path);
    const subject = {
      directory: history.directory,
      path,
      from,
      backup: `${path}.schema-${from}.backup`,
    };
    const before = yield* withStore(subject.directory, (store) =>
      store.recover(),
    );
    Object.assign(steps, { [subject.from + 1]: addMarker });

    yield* openAndClose(subject.directory);

    expect(version(subject.path)).toBe(subject.from + 1);
    expect(version(subject.backup)).toBe(subject.from);
    expect(statSync(subject.backup).mode & 0o077).toBe(0);
    const recovered = yield* Effect.scoped(
      openEndpointStore(subject.directory, storeOptions).pipe(
        Effect.flatMap((store) => store.recover()),
      ),
    );
    expect(recovered).toEqual(before);
    expect(
      yield* readStoredHistory(
        history.signer,
        recovered,
        recovered.certifiedRecords,
      ),
    ).toEqual([history.record]);
  }));

it("rolls a failed step back and replaces both a prior backup and leftover temporary file on retry", () =>
  Effect.gen(function* () {
    const subject = yield* prepare();
    Object.assign(steps, {
      [subject.from + 1]: (database: DatabaseSync) => {
        addMarker(database);
        throw new Error("synthetic migration failure");
      },
    });
    expect(yield* Effect.exit(openAndClose(subject.directory))).toMatchObject(
      Exit.fail({ _tag: "EndpointStoreError", reason: "persistence" }),
    );
    expect(version(subject.path)).toBe(subject.from);
    expect(version(subject.backup)).toBe(subject.from);
    const failed = new DatabaseSync(subject.path);
    expect(
      failed
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name = 'migration_marker'",
        )
        .get(),
    ).toBeUndefined();
    failed.exec("CREATE TABLE retry_marker (value TEXT)");
    failed.close();
    writeFileSync(`${subject.backup}.tmp`, "interrupted backup");
    Object.assign(steps, { [subject.from + 1]: addMarker });

    yield* openAndClose(subject.directory);

    expect(version(subject.path)).toBe(subject.from + 1);
    const backup = new DatabaseSync(subject.backup, { readOnly: true });
    expect(
      backup
        .prepare("SELECT name FROM sqlite_schema WHERE name = 'retry_marker'")
        .get(),
    ).toEqual({ name: "retry_marker" });
    backup.close();
    expect(existsSync(`${subject.backup}.tmp`)).toBe(false);
  }));

it("refuses a newer store before any file or backup mutation", () =>
  Effect.gen(function* () {
    const subject = yield* prepare();
    const database = new DatabaseSync(subject.path);
    database.exec(`PRAGMA user_version = ${subject.from + 2}`);
    database.close();
    const before = readFileSync(subject.path);

    expect(yield* Effect.exit(openAndClose(subject.directory))).toMatchObject(
      Exit.fail({ _tag: "EndpointStoreError", reason: "newer-schema" }),
    );
    expect(readFileSync(subject.path)).toEqual(before);
    expect(existsSync(subject.backup)).toBe(false);
  }));

it("refuses a retired pending envelope before creating a backup or running a step", () =>
  Effect.gen(function* () {
    const subject = yield* prepare();
    const { foundation } = storedConversation("stale");
    yield* Effect.scoped(
      openEndpointStore(subject.directory, storeOptions).pipe(
        Effect.flatMap((store) => store.putConversationFoundation(foundation)),
      ),
    );
    const database = new DatabaseSync(subject.path);
    const bytes = Buffer.from(
      JSON.stringify({
        payload: Buffer.from(
          JSON.stringify({ moltzapVersion: "retired" }),
        ).toString("base64url"),
      }),
    );
    database
      .prepare(
        `INSERT INTO outbound_messages (conversation_id, message_id, canonical_signed_message, wire_version, attempted, disposition) VALUES (?, 'message', ?, 'retired', 0, 'pending')`,
      )
      .run(foundation.conversationId, bytes);
    database.close();
    const before = readFileSync(subject.path);
    Object.assign(steps, { [subject.from + 1]: addMarker });

    expect(
      yield* Effect.exit(openAndClose(subject.directory, ["live"])),
    ).toMatchObject(Exit.fail({ _tag: "OutboxTooOldError" }));
    expect(readFileSync(subject.path)).toEqual(before);
    expect(existsSync(subject.backup)).toBe(false);
  }));

it("leaves the store untouched when a read-only directory prevents the backup", () =>
  Effect.gen(function* () {
    const subject = yield* prepare();
    Object.assign(steps, { [subject.from + 1]: addMarker });
    const before = readFileSync(subject.path);
    chmodSync(subject.directory, 0o500);
    const result = yield* Effect.exit(
      Effect.scoped(
        openStoreState(subject.directory, {
          liveWireVersions: LIVE_WIRE_VERSIONS,
          migrations: steps,
        }).pipe(Effect.tap(closeStoreState)),
      ),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          chmodSync(subject.directory, 0o700);
        }),
      ),
    );

    expect(result).toMatchObject(
      Exit.fail({ _tag: "EndpointStoreError", reason: "persistence" }),
    );
    expect(readFileSync(subject.path)).toEqual(before);
    expect(version(subject.path)).toBe(subject.from);
    expect(existsSync(subject.backup)).toBe(false);
  }));

it("retains exclusive ownership across backup and every migration step", () =>
  Effect.gen(function* () {
    const subject = yield* prepare();
    const competitor = new DatabaseSync(subject.path, {
      readOnly: true,
      timeout: 0,
    });
    const excludesCompetitor = (database: DatabaseSync) => {
      expect(() => competitor.prepare("PRAGMA user_version").get()).toThrow();
      addMarker(database);
    };
    Object.assign(steps, { [subject.from + 1]: excludesCompetitor });
    yield* openAndClose(subject.directory).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          competitor.close();
        }),
      ),
    );
    expect(version(subject.path)).toBe(subject.from + 1);
  }));

it("stops before migrating when an obstructed temporary backup cannot be removed", () =>
  Effect.gen(function* () {
    const subject = yield* prepare();
    Object.assign(steps, { [subject.from + 1]: addMarker });
    mkdirSync(`${subject.backup}.tmp`);
    const before = readFileSync(subject.path);

    expect(yield* Effect.exit(openAndClose(subject.directory))).toMatchObject(
      Exit.fail({ _tag: "EndpointStoreError", reason: "persistence" }),
    );
    expect(readFileSync(subject.path)).toEqual(before);
    expect(version(subject.path)).toBe(subject.from);
    expect(existsSync(subject.backup)).toBe(false);
  }));

it("resumes from the last committed step after a later step fails", () =>
  Effect.gen(function* () {
    const subject = yield* prepare();
    Object.assign(steps, {
      [subject.from + 1]: addMarker,
      [subject.from + 2]: (database: DatabaseSync) => {
        database.exec("CREATE TABLE later_marker (value TEXT)");
        throw new Error("later migration failure");
      },
    });

    expect(yield* Effect.exit(openAndClose(subject.directory))).toMatchObject(
      Exit.fail({ _tag: "EndpointStoreError", reason: "persistence" }),
    );
    expect(version(subject.path)).toBe(subject.from + 1);
    Object.assign(steps, {
      [subject.from + 2]: (database: DatabaseSync) => {
        database.exec("CREATE TABLE later_marker (value TEXT)");
      },
    });
    yield* openAndClose(subject.directory);

    expect(version(subject.path)).toBe(subject.from + 2);
    expect(version(subject.backup)).toBe(subject.from);
    expect(version(`${subject.path}.schema-${subject.from + 1}.backup`)).toBe(
      subject.from + 1,
    );
  }));

it("drops the retained keyed sends of a schema-10 store and keeps the rest of its state", () =>
  Effect.gen(function* () {
    const subject = yield* prepare();
    expect(subject.from).toBe(RESET_SCHEMA);
    const before = yield* Effect.scoped(
      openEndpointStore(subject.directory, storeOptions).pipe(
        Effect.flatMap((store) => store.recover()),
      ),
    );
    const database = new DatabaseSync(subject.path);
    database.exec(`CREATE TABLE runtime_sends (
      invocation_key TEXT PRIMARY KEY,
      canonical_input BLOB NOT NULL,
      canonical_outcome BLOB
    ) STRICT;
    INSERT INTO runtime_sends (invocation_key, canonical_input) VALUES ('key', x'00')`);
    database.close();

    const recovered = yield* Effect.scoped(
      openEndpointStore(subject.directory, {
        liveWireVersions: LIVE_WIRE_VERSIONS,
      }).pipe(Effect.flatMap((store) => store.recover())),
    );

    expect(version(subject.path)).toBeGreaterThan(subject.from);
    expect(version(subject.backup)).toBe(RESET_SCHEMA);
    const upgraded = new DatabaseSync(subject.path, { readOnly: true });
    expect(
      upgraded
        .prepare("SELECT name FROM sqlite_schema WHERE name = 'runtime_sends'")
        .get(),
    ).toBeUndefined();
    upgraded.close();
    expect(recovered).toEqual(before);
  }));

function seedUnresolvedIntent(store: EndpointStore) {
  const { foundation } = storedConversation("schema-11");
  return Effect.gen(function* () {
    yield* store.bindIdentity({
      agentId: "agent:alice",
      canonicalAgentCard: new Uint8Array([1]),
    });
    yield* store.putConversationFoundation(foundation);
    yield* store.bindPostIntent({
      kind: "existing-conversation",
      intent: {
        conversationId: foundation.conversationId,
        membershipHash: foundation.membershipHash,
        authorAgentId: "agent:alice",
        postId: "pst_pending",
        canonicalIntent: new Uint8Array([1]),
      },
    });
  });
}

function upgradesSchema11WithUnresolvedIntents() {
  return Effect.gen(function* () {
    const directory = stateDirectory();
    const { foundation } = storedConversation("schema-11");
    yield* withStore(directory, seedUnresolvedIntent);
    const path = databasePath(directory);
    const currentSchema = version(path);
    const previousSchema = 11;
    const database = new DatabaseSync(path);
    const freshIndex = database
      .prepare(
        "SELECT name, partial FROM pragma_index_list('post_intents') WHERE name = 'post_intents_unresolved'",
      )
      .get();
    database.exec(
      `DROP INDEX post_intents_unresolved; PRAGMA user_version = ${previousSchema}`,
    );
    database.close();

    const pending = yield* withStore(directory, (store) =>
      store.readFirewallEvidence({
        conversationId: foundation.conversationId,
        maximumRecords: 10,
      }),
    );

    expect(pending.pendingOutgoing).toBe(true);
    expect(version(path)).toBe(currentSchema);
    expect(version(`${path}.schema-${previousSchema}.backup`)).toBe(
      previousSchema,
    );
    const upgraded = new DatabaseSync(path, { readOnly: true });
    expect(
      upgraded
        .prepare(
          "SELECT name, partial FROM pragma_index_list('post_intents') WHERE name = 'post_intents_unresolved'",
        )
        .get(),
    ).toEqual(freshIndex);
    const plan = upgraded
      .prepare(
        "EXPLAIN QUERY PLAN SELECT 1 FROM post_intents WHERE conversation_id = ? AND completed_record_hash IS NULL LIMIT 1",
      )
      .get(foundation.conversationId);
    expect(plan?.detail).toContain(freshIndex?.name);
    upgraded.close();
  });
}

it(
  "upgrades a schema-11 store with its unresolved intents and conversation index",
  upgradesSchema11WithUnresolvedIntents,
);
