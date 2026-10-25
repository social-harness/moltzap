/**
 * @file Condition-only service capabilities for bootstrap and registered-request verification, card signing, Registry and Router contracts and clients, and wire compatibility.
 * @internal
 */

/** Bootstrap admission retains its typed signature proof. */
export {
  type VerifiedHttpSignature,
  verifyBootstrapRequest,
} from "./identity/signing/http-signature.js";
/** Registry issuance and Router fixtures name card verification failures and digests. */
export {
  AgentCardDigest,
  agentCardSigning,
  type AgentCardVerificationError,
} from "./identity/cards.js";
/** Services compose the installed wire compatibility policy. */
export {
  HISTORY_WIRE_VERSIONS,
  LIVE_WIRE_VERSIONS,
  WIRE_VERSION,
  type WireVersion,
  wireVersions,
} from "./identity/wire-version.js";
/** Registered HTTP authentication retains its opaque verified proof. */
export {
  AuthenticatedHttp,
  type VerifiedAgentRequest,
} from "./identity/signing/registered/index.js";
/** Service adapters construct and decode closed HTTP envelope failures. */
export { httpErrors } from "./identity/signing/http-errors.js";
/** Service compositions share the daemon's Registry client tag. */
export { Registry } from "./identity/registry/index.js";
/** Service compositions share the daemon's Router client tag. */
export { Router } from "./communication/router/api/client.js";
/** Registry HTTP and storage adapters share one exact wire contract. */
export { registryContract } from "./identity/registry/contract.js";
/** Router HTTP, feed and cursor adapters share one exact wire contract. */
export { routerContract } from "./communication/router/api/contract.js";
