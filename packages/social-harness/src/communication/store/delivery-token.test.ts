/** @file Delivery tokens reject ambiguous base64url representations. */

import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { DeliveryToken } from "./index.js";

describe("delivery tokens", () => {
  it("rejects non-canonical base64url trailing bits", () => {
    const decode = Schema.decodeUnknownSync(DeliveryToken);
    const canonical = `dlv_${"A".repeat(43)}`;
    expect(decode(canonical)).toBe(canonical);
    expect(() => decode(`dlv_${"A".repeat(42)}B`)).toThrow();
  });
});
