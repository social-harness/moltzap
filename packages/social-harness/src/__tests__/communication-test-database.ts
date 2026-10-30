/** @file Scoped real SQL resources for communication protocol scenarios. */

import { SqlClient } from "@effect/sql";
import { Context, Effect, Layer } from "effect";
import { layer } from "../daemon/store.js";
import { LIVE_WIRE_VERSIONS } from "../identity/wire-version.js";
import { stateDirectory, testStore } from "./store-schema-fixtures.js";

/** Captures one database for engine callbacks and later state assertions in the same test scope. */
export const openTestDatabase = (directory?: string) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      layer({
        stateDirectory: directory ?? stateDirectory(),
        liveWireVersions: LIVE_WIRE_VERSIONS,
      }),
    );
    const sql = Context.get(services, SqlClient.SqlClient);
    return {
      sql,
      store: testStore,
      run: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    };
  }).pipe(Effect.withSpan("openTestDatabase"));

/** A database lifetime and one generic operation runner, without a storage facade. */
export type TestDatabase = Effect.Effect.Success<
  ReturnType<typeof openTestDatabase>
>;
