/** @file Message content exposed by saved daemon history views. */

import type { Content } from "@moltzap/social-harness";
import type { managementReadConversationResultSchema } from "@moltzap/social-harness/test";
import assert from "node:assert/strict";

type HistoryRecord =
  (typeof managementReadConversationResultSchema.Type)["records"][number];

/** Direct-message scenarios require a saved multicast view for every received record. */
export function historyMessageContent(record: HistoryRecord): Content {
  if (record.kind === "sent") {
    return record.content;
  }
  assert(
    record.item.kind === "multicast",
    `Expected saved multicast history, received ${record.item.kind}`,
  );
  return record.item.message.content;
}
