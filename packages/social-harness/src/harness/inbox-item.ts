/** @file Agent-visible inbox content and lookup references use application identities. */

import { absurd, Schema } from "effect";
import { AgentAddress, GroupAddress } from "../communication/messages.js";
import { CollectiveId, MessageReference } from "../communication/service.js";
import { exactStruct } from "../encoding/canonical-json.js";
import { LocalGuidance, PermittedItem } from "../firewall/service.js";

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare, agent-code-guard/no-exported-brand-constructor -- These owning schemas compose the inbox, MCP and host-facing contracts. */

/** Canonical host address of a direct or group conversation. */
export const MessageAddress = Schema.Union(AgentAddress, GroupAddress);
/** @useDeclaredType */
export type MessageAddress = typeof MessageAddress.Type;

/** Permitted content and saved guidance, without delivery bookkeeping. */
export const InboxEvent = Schema.Struct({
  address: MessageAddress,
  item: PermittedItem,
  guidance: Schema.optionalWith(LocalGuidance, { exact: true }),
});
/** @useDeclaredType */
export type InboxEvent = typeof InboxEvent.Type;

/** A peer message belongs to its author; an operation reference names its terminal outcome. */
export const InboxReference = Schema.Union(
  exactStruct({ message: MessageReference }),
  exactStruct({ operationId: CollectiveId }),
);
/** @useDeclaredType */
export type InboxReference = typeof InboxReference.Type;

/* eslint-enable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare, agent-code-guard/no-exported-brand-constructor -- Restore defaults after the owning schemas. */

/** Copies the agent's saved view without exposing the enclosing delivery record. */
export function projectInboxEvent(event: InboxEvent): InboxEvent {
  return {
    address: event.address,
    item: event.item,
    ...(event.guidance === undefined ? {} : { guidance: event.guidance }),
  };
}

/** The same application reference retrieves inline and oversized received items. */
export function inboxReference(event: InboxEvent): InboxReference {
  const item = event.item;
  switch (item.kind) {
    case "multicast":
    case "collectiveRequest":
      return {
        message: {
          authorAgentId: item.message.author.agentId,
          msgId: item.message.msgId,
        },
      };
    case "collectiveResult":
    case "operationFailed":
      return { operationId: item.operationId };
    default:
      return absurd(item);
  }
}
