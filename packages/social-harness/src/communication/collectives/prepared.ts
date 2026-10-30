/** @file Exact operation preparations carry no policy authority or host guidance. */
import type { PreparedSend } from "../conversations/index.js";
import type { AgentAddress, GroupAddress } from "../records/values.js";
import type { CollectiveId } from "./contracts.js";
import type { ReceivedRequest } from "./received-request.js";
import type { PreparedGather } from "./state.js";
import type { ResponseValue } from "./wire/index.js";
/** Each operation accepts only the canonical message identities it prepared. */
export type PreparedCollective =
  | {
      readonly kind: "multicast";
      readonly to: AgentAddress | GroupAddress;
      readonly message: PreparedSend;
    }
  | { readonly kind: "response"; readonly response: PreparedResponse }
  | { readonly kind: "collective"; readonly gather: PreparedGather };

/** Request validation precedes assessment; the protocol claim waits until acceptance. */
export interface PreparedResponse {
  readonly operationId: CollectiveId;
  readonly request: ReceivedRequest;
  readonly value: ResponseValue;
  readonly message: PreparedSend;
}
