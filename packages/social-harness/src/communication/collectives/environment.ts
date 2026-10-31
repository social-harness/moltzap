/** @file The collective service captures these resources once per scope. */

import type * as SqlClient from "@effect/sql/SqlClient";
import type { Context, Deferred, Scope } from "effect";
import type { Identity } from "../../identity/local.js";
import type { Communication } from "../index.js";
import type { CollectivesError } from "./errors.js";

/** Outgoing worker bookkeeping belongs to the same lifetime as its saved custody. */
export interface Environment {
  readonly sql: SqlClient.SqlClient;
  readonly communication: Context.Tag.Service<typeof Communication>;
  readonly identity: Context.Tag.Service<typeof Identity>;
  readonly scope: Scope.Scope;
  readonly failed: Deferred.Deferred<never, CollectivesError>;
  readonly activeMessages: Set<string>;
}
