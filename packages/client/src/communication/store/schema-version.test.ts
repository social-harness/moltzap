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
import { RESET_SCHEMA } from "./database/migrations.js";
import { openEndpointStore } from "./index.js";

/** The schema the previous release wrote. */
const EARLIER_SCHEMA_VERSION = RESET_SCHEMA - 1;

function refusesAnEarlierSchemaUnchanged() {
  return Effect.gen(function* () {
    const directory = stateDirectory();
    yield* withStore(directory, (store) => store.recover());
    const path = databasePath(directory);
    const database = new DatabaseSync(path);
    database.exec(`PRAGMA user_version = ${EARLIER_SCHEMA_VERSION}`);
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

describe("endpoint store schema version", () => {
  it(
    "refuses a store at an earlier schema version and leaves its file unchanged",
    refusesAnEarlierSchemaUnchanged,
  );
});
