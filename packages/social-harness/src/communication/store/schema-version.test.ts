/** @file A store from an earlier schema is refused unchanged: schemas below the migration baseline require an explicit reset. */

import { live as it } from "@effect/vitest";
import { Effect, Exit } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- The test compares the exact database bytes before and after the refused open.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect } from "vitest";
import {
  databasePath,
  stateDirectory,
  withStore,
} from "../../__tests__/store-schema-fixtures.js";
import { LIVE_WIRE_VERSIONS } from "../../identity/wire-version.js";
import { openEndpointStore } from "./index.js";

/** The last schema before the reset is refused even with otherwise valid state. */
const EARLIER_SCHEMA_VERSION = 14;

function refusesAnEarlierSchemaUnchanged() {
  return Effect.gen(function* () {
    const directory = stateDirectory();
    const path = databasePath(directory);
    const database = new DatabaseSync(path);
    database.exec(`PRAGMA user_version = ${EARLIER_SCHEMA_VERSION}`);
    database.exec("CREATE TABLE old_identity (agent_id TEXT PRIMARY KEY)");
    database
      .prepare("INSERT INTO old_identity VALUES (?)")
      .run("retained-owner");
    database.close();
    const original = readFileSync(path);

    const opened = yield* Effect.exit(
      Effect.scoped(
        openEndpointStore(directory, { liveWireVersions: LIVE_WIRE_VERSIONS }),
      ),
    );

    expect(opened).toMatchObject(
      Exit.fail({ _tag: "EndpointStoreError", reason: "pre-reset" }),
    );
    expect(readFileSync(path)).toEqual(original);
  });
}

function opensFreshBaseline() {
  return Effect.gen(function* () {
    const directory = stateDirectory();
    const initial = yield* withStore(directory, (store) => store.recover());

    expect(yield* withStore(directory, (store) => store.recover())).toEqual(
      initial,
    );
  });
}

describe("endpoint store schema version", () => {
  it(
    "opens a fresh store at the reset baseline and reopens it",
    opensFreshBaseline,
  );
  it(
    "refuses a store at an earlier schema version and leaves its file unchanged",
    refusesAnEarlierSchemaUnchanged,
  );
});
