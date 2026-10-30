/** @file Immutable host projections add locally withheld text to canonical collective results. */

import { Schema } from "effect";
import {
  collectiveResultItem,
  InboundItem as ProtocolItem,
} from "../communication/collectives/inbound.js";
import { wellFormedString } from "../communication/records/values.js";
import { exactStruct } from "../encoding/exact.js";
import { withheldText } from "../firewall/outcome/index.js";
import { AgentView } from "../identity/cards.js";

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Schema values share their boundary type names. */

const projectedResult = exactStruct({
  ...collectiveResultItem.fields,
  question: Schema.Union(wellFormedString, withheldText),
  outcomes: Schema.NonEmptyArray(
    exactStruct({
      member: AgentView,
      outcome: Schema.Union(
        collectiveResultItem.fields.outcomes.value.fields.outcome,
        withheldText,
      ),
    }),
  ),
});
/** Retained local visibility is separate from the shared protocol result. */
export const InboundItem = Schema.Union(
  ProtocolItem.members[0],
  ProtocolItem.members[1],
  projectedResult,
  ProtocolItem.members[3],
).annotations({ identifier: "InboundItem" });
/** Host-visible content includes locally withheld question and answer text. */
export type InboundItem = typeof InboundItem.Type;

/* eslint-enable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Restore naming after boundary schema declarations. */
