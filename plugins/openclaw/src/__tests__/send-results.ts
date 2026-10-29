/** @file The results `HarnessEndpoint.send` returns, for fakes that stand in for it. */

import {
  decodeHarnessSendResult,
  type SendInput,
} from "@moltzap/social-harness";
import { Effect, Encoding } from "effect";

/** The operation id every fake gather, all_gather and answer reports. */
export const OPERATION_ID = `col_${Encoding.encodeBase64Url(new Uint8Array(32).fill(5))}`;

/**
 * The endpoint's own result for the nth send, from 0: a multicast returns message
 * `msgId(100 + n)` and its address, an answer adds the request's operation
 * id, and a gather or all_gather returns only its operation id.
 * @param input The send the fake received.
 * @param index Its position among the fake's sends, from 0.
 * @returns The decoded result.
 */
export function endpointResult(input: SendInput, index: number) {
  const message = { msgId: msgId(100 + index), address: input.to };
  const operation = { operationId: OPERATION_ID };
  if ("collectiveResponse" in input) {
    return decodeHarnessSendResult({
      kind: "response",
      ...operation,
      ...message,
    }).pipe(Effect.orDie);
  }
  return decodeHarnessSendResult(
    input.collective === undefined
      ? { kind: "multicast", ...message }
      : { kind: "collective", ...operation },
  ).pipe(Effect.orDie);
}

/**
 * A well-formed message id whose 32 bytes are all `fill`.
 * @param fill The byte every position holds.
 * @returns The `msg_` id.
 */
export function msgId(fill: number): string {
  return `msg_${Encoding.encodeBase64Url(new Uint8Array(32).fill(fill))}`;
}
