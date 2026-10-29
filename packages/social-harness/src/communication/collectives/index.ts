/** @file The collective operations the daemon service composes. */

/** The daemon's stateful gather and all_gather operations. */
export { makeCollectiveOperations } from "./operation.js";
/** The ports the layer runs on, what a firewall adds, and the operations it offers. */
export {
  type AdmittedGather,
  type CollectiveAdmission,
  type CollectiveOperations,
  type GatherCandidate,
  ResultProvenance,
} from "./ports.js";
/** The failure an emit port returns when the service cannot keep an item. */
export { CollectiveEmitError } from "./contracts.js";
/** The items those operations emit. */
export type { InboundItem } from "./inbound.js";

/** Certified multicast projection preserves every non-protocol content part. */
export {
  type CollectiveValue,
  readCollectiveValue,
  withoutCollectivePart,
} from "./wire/index.js";
