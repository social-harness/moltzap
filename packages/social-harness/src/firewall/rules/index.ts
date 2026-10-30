/** @file Built-in middleware registrations for policy composition. */

/** Policy documents select deterministic credential, language, acknowledgement and sender checks. */
export {
  acknowledgementsPolicy,
  ALLOWED_SENDERS_ID,
  allowedSendersPolicy,
  credentialsPolicy,
  localGuidanceImpersonationRule,
  plainLanguagePolicy,
} from "./builtin.js";
