/** @file Certified inbound messages, direct or to a fixed group. */

import { Schema } from "effect";
import { exactStruct } from "../../encoding/exact.js";
import { AgentView } from "../../identity/cards.js";
import {
  AgentAddress,
  Content,
  GroupAddress,
  maximumMembers,
  parseAgentAddress,
  parseGroupAddress,
  PostId,
} from "../records/values.js";

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Effect Schemas share their domain names with the nominal values they decode. */

const directMessageStructure = exactStruct({
  kind: Schema.Literal("direct"),
  postId: PostId,
  address: AgentAddress,
  sender: AgentView,
  content: Content,
});

const directMessage = directMessageStructure.pipe(
  Schema.filter(
    (message) =>
      parseAgentAddress(message.address) === message.sender.agentName,
    {
      identifier: "DirectMessage",
      description: "A direct delivery addressed by its remote sender",
    },
  ),
);

const groupMembers = Schema.Tuple(
  [AgentView, AgentView, AgentView],
  AgentView,
).pipe(Schema.maxItems(maximumMembers));

const groupMessageStructure = exactStruct({
  kind: Schema.Literal("group"),
  postId: PostId,
  address: GroupAddress,
  sender: AgentView,
  members: groupMembers,
  content: Content,
});

const groupMessage = groupMessageStructure.pipe(
  Schema.filter(
    (message) => {
      const addressNames = parseGroupAddress(message.address);
      return (
        addressNames !== undefined &&
        addressNames.length === message.members.length &&
        message.members.every(
          (member, index) => member.agentName === addressNames[index],
        ) &&
        new Set(message.members.map((member) => member.agentId)).size ===
          message.members.length &&
        message.members.some(
          (member) =>
            member.agentId === message.sender.agentId &&
            member.agentName === message.sender.agentName &&
            member.principalId === message.sender.principalId,
        )
      );
    },
    {
      identifier: "GroupMessage",
      description:
        "A group delivery whose canonical address, members, and sender agree",
    },
  ),
);

/** One certified remote-authored direct message. */
export type DirectMessage = typeof directMessage.Type;
/** One certified remote-authored fixed-group message. */
export type GroupMessage = typeof groupMessage.Type;

/** One certified remote-authored post, direct or to a fixed group. */
export const InboundMessage = Schema.Union(
  directMessage,
  groupMessage,
).annotations({ identifier: "InboundMessage" });
/** A validated direct or group post. */
export type InboundMessage = typeof InboundMessage.Type;

/* eslint-enable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Restore the package naming rules after the Schema/type pairs. */
