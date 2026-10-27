/** @file Built-in middleware registrations for policy composition. */

/** Policy documents select deterministic credential, language, acknowledgement, open-request and sender checks. */
export {
  acknowledgementsPolicy,
  ALLOWED_SENDERS_ID,
  allowedSendersPolicy,
  credentialsPolicy,
  localGuidanceImpersonationRule,
  openRequestsPolicy,
  plainLanguagePolicy,
} from "./builtin.js";
/** Collective participation composes code and English norms under one shared revision. */
export { type CollectiveNorms, collectiveNorms } from "./collective-norms.js";
