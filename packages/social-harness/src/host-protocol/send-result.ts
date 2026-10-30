/** @file Host send results attach local advice to ordinary communication outcomes. */

import { Schema } from "effect";
import { SendResultSchema as ProtocolResult } from "../communication/collectives/contracts.js";
import { checkedGuidanceSchema } from "../firewall/check.js";
/* eslint-disable @typescript-eslint/naming-convention -- Schema values share their boundary type names. */

const [multicast, response, collective] = ProtocolResult.members;
const guidance = {
  guidance: Schema.optionalWith(checkedGuidanceSchema, { exact: true }),
};
/** Local advice does not become protocol state or change the accepted message. */
export const SendResultSchema = Schema.Union(
  Schema.Struct({ ...multicast.fields, ...guidance }),
  Schema.Struct({ ...response.fields, ...guidance }),
  Schema.Struct({ ...collective.fields, ...guidance }),
).annotations({ identifier: "SendResult" });
/** The host observes its invocation's ordinary result and any admitted advice. */
export type SendResult = typeof SendResultSchema.Type;

/* eslint-enable @typescript-eslint/naming-convention -- Restore naming after boundary schema declarations. */
