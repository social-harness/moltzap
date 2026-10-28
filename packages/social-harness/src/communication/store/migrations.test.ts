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
import { closeStoreState, openStoreState } from "./database/schema.js";
import { openEndpointStore } from "./index.js";

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
    ).toEqual([expect.objectContaining({ record: history.record })]);
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
