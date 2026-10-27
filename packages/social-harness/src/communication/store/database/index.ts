/** @file Stable internal boundary for SQLite state and closed value checks. */

/** SQLite ownership, transaction, and lifecycle primitives. */
export {
  closeStoreState,
  type HistorySnapshot,
  inspectStoreState,
  openStoreState,
  runStoreOperation,
  type StoreOpening,
  type StoreState,
  transaction,
} from "./schema.js";
/** Closed failures and exact canonical-value helpers. */
export {
  copyBytes,
  EndpointStoreError,
  type EndpointStoreFailure,
  mapStoreFailure,
  mintContinuation,
  mintDeliveryToken,
  readBytes,
  readInteger,
  readOptionalBytes,
  readOptionalText,
  readText,
  requireBytes,
  requireEqual,
  requireSameBytes,
  requireSameOptionalBytes,
  requireText,
  StoreSignal,
  validateContinuation,
} from "./values.js";

/** Synthetic migration policies enter through the database boundary. */
export type { MigrationSteps } from "./migrations.js";
