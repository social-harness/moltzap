/** @file Delivery tokens decode only in canonical form, and minting bounds collision exhaustion with a persistence signal. */

import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { mintDeliveryToken, StoreSignal } from "./database/index.js";
import { DeliveryToken } from "./index.js";

const candidateIsRetained = () => true;

describe("delivery tokens", () => {
  it("rejects non-canonical base64url trailing bits", () => {
    const decode = Schema.decodeUnknownSync(DeliveryToken);
    const canonical = `dlv_${"A".repeat(43)}`;
    expect(decode(canonical)).toBe(canonical);
    expect(() => decode(`dlv_${"A".repeat(42)}B`)).toThrow();
  });

  it("reports persistence failure when every candidate is retained", () => {
    expect(() => mintDeliveryToken(candidateIsRetained)).toThrow(
      new StoreSignal("persistence"),
    );
  });
});
