/**
 * @file Live admission carries a nominal version witness across Router send
 * and Client ingress; retained history alone cannot satisfy either boundary.
 */

import type { Types } from "effect";
import type {
  LiveSignedMessage,
  SignedMessage,
  VerifiedSignedMessage,
} from "../envelope/signed-message.js";
import type { verifyOuterMessage } from "../records/index.js";
import type { RouterSendRequest } from "./api/contract.js";
import type { RouterWorkerIngress } from "./index.js";

type Expect<Value extends true> = Value;

/** Compile-time witnesses for both live-admission boundaries. */
export type LiveMessageCanaries = [
  Expect<Types.Equals<RouterSendRequest["signedMessage"], LiveSignedMessage>>,
  Expect<
    Types.Equals<
      Parameters<typeof verifyOuterMessage>[0]["message"],
      LiveSignedMessage
    >
  >,
  Expect<
    Types.Equals<
      RouterWorkerIngress<unknown>["message"],
      LiveSignedMessage & VerifiedSignedMessage
    >
  >,
  Expect<
    Types.Equals<SignedMessage extends LiveSignedMessage ? true : false, false>
  >,
];
