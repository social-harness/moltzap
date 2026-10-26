/** @file Refusal references and next actions survive the public printable error boundary. */

import { Encoding } from "effect";
import { expect, it } from "vitest";
import { FirewallSendError } from "../../index.js";

const checkId = `chk_${Encoding.encodeHex(new Uint8Array(32).fill(2))}`;
const advice = "The communication prerequisite is not satisfied.";

it("retains the check reference when no advice is supplied", () => {
  const error = new FirewallSendError({
    checkId,
    refusal: "norm-violation",
    feedback: [],
  });
  expect(error.message).toContain(checkId);
});

it.each([
  { nextAction: "revise", refusal: "norm-violation" },
  { nextAction: "wait", refusal: "norm-violation" },
  { nextAction: "stop", refusal: "norm-violation" },
] as const)(
  "prints the check, advice and $nextAction next action",
  ({ nextAction, refusal }) => {
    const rendered = String(
      new FirewallSendError({
        checkId,
        refusal,
        feedback: [{ nextAction, text: advice }],
      }),
    );
    expect(rendered).toContain(checkId);
    expect(rendered).toContain(nextAction);
    expect(rendered).toContain(advice);
    expect(rendered).not.toMatch(/needs revision/u);
  },
);
