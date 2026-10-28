/** @file The results `HarnessEndpoint.send` returns, for fakes that stand in for it. */

import { decodeHarnessSendResult, type SendInput } from "@moltzap/social-harness";
import { Effect, Encoding } from "effect";

/** The operation id every fake gather, all_gather and answer reports. */
export const OPERATION_ID = `col_${Encoding.encodeBase64Url(new Uint8Array(32).fill(5))}`;

/**
 * The endpoint's own result for the nth send, from 0: a multicast returns post
 * `postId(100 + n)` and its address, an answer adds the request's operation
 * id, and a gather or all_gather returns only its operation id.
 * @param input The send the fake received.
 * @param index Its position among the fake's sends, from 0.
 * @returns The decoded result.
 */
export function endpointResult(input: SendInput, index: number) {
  const post = { postId: postId(100 + index), address: input.to };
  const operation = { operationId: OPERATION_ID };
  if ("collectiveResponse" in input) {
    return decodeHarnessSendResult({ ...operation, ...post }).pipe(
      Effect.orDie,
    );
  }
  return decodeHarnessSendResult(
    input.collective === undefined ? post : operation,
  ).pipe(Effect.orDie);
}

/**
 * A well-formed post id whose 32 bytes are all `fill`.
 * @param fill The byte every position holds.
 * @returns The `pst_` id.
 */
export function postId(fill: number): string {
  return `pst_${Encoding.encodeBase64Url(new Uint8Array(32).fill(fill))}`;
}
