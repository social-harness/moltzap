/** @file Stable internal boundary for SQLite state and closed value checks. */

/** SQL schema, transaction and closed failure boundaries. */
export {
  createCommunicationTables,
  inspectStoreState,
  storeOperation,
  transaction,
  type StoreOpening,
} from "./schema.js";
/** Closed failures and exact canonical-value helpers. */
export {
  EndpointStoreError,
  StoreSignal,
  copyBytes,
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
} from "./values.js";
