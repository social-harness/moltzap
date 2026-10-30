/** @file Exact operation preparations carry no policy authority or host guidance. */
import type { PreparedSend } from "../conversations/index.js";
import type { AgentAddress, GroupAddress } from "../records/values.js";
import type { PreparedResponse } from "./responses.js";
import type { PreparedGather } from "./state.js";
/** Each operation accepts only the canonical message identities it prepared. */
export type PreparedCollective =
  | {
      readonly kind: "multicast";
      readonly to: AgentAddress | GroupAddress;
      readonly message: PreparedSend;
    }
  | { readonly kind: "response"; readonly response: PreparedResponse }
  | { readonly kind: "collective"; readonly gather: PreparedGather };
