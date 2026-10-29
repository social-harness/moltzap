/** @file Exact wire grammar of the owner management address schemas. */

import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { digest } from "../__tests__/agent-card-fixtures.js";
import {
  managementReadConversationRequestSchema,
  managementReadConversationResultSchema,
  managementSearchConversationsRequestSchema,
  managementSearchConversationsResultSchema,
} from "./owner-tools.js";

const conversationId = digest("cnv_", 1);

function rejectsNonCanonicalContinuations(): void {
  const canonical = "A".repeat(43);
  const nonCanonical = `${"A".repeat(42)}B`;
  const decodeRequest = Schema.decodeUnknownSync(
    managementReadConversationRequestSchema,
  );
  const decodePage = Schema.decodeUnknownSync(
    managementReadConversationResultSchema,
  );
  expect(decodeRequest({ continuation: canonical })).toEqual({
    continuation: canonical,
  });
  expect(() => decodeRequest({ continuation: nonCanonical })).toThrow();
  const page = { kind: "page", records: [], continuation: canonical };
  expect(decodePage(page)).toEqual(page);
  expect(() => decodePage({ ...page, continuation: nonCanonical })).toThrow();
}

// @agent-code-guard/regression-only: the wire schema accepts only address cursors and canonical pages.
describe("management address schemas", () => {
  it(
    "rejects non-canonical history continuation trailing bits",
    rejectsNonCanonicalContinuations,
  );

  it("accepts canonical address cursors and rejects excess fields", () => {
    expect(
      Schema.decodeUnknownSync(managementSearchConversationsRequestSchema)({
        afterAddress: "agent:bob",
      }),
    ).toEqual({ afterAddress: "agent:bob" });
    expect(() =>
      Schema.decodeUnknownSync(managementSearchConversationsRequestSchema)({
        afterConversationId: conversationId,
      }),
    ).toThrow();
  });

  it("requires strictly ordered address pages", () => {
    expect(
      Schema.decodeUnknownSync(managementSearchConversationsResultSchema)({
        kind: "page",
        addresses: ["agent:bob", "group:alice,bob,carol"],
        hasMore: false,
      }),
    ).toEqual({
      kind: "page",
      addresses: ["agent:bob", "group:alice,bob,carol"],
      hasMore: false,
    });
    expect(() =>
      Schema.decodeUnknownSync(managementSearchConversationsResultSchema)({
        kind: "page",
        addresses: ["group:alice,bob,carol", "agent:bob"],
        hasMore: false,
      }),
    ).toThrow();
  });
});
