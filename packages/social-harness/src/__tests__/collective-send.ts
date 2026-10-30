/** @file Tests compose the ordinary collective preparation and acceptance operations. */
import { Effect } from "effect";
import type { SendInput } from "../communication/collectives/contracts.js";
import { makeCollectiveOperations as makeProtocol } from "../communication/collectives/index.js";

/** Operation tests use the same preparation and acceptance sequence as the daemon. */
export const makeCollectiveOperations = (
  ports: Parameters<typeof makeProtocol>[0],
) =>
  makeProtocol(ports).pipe(
    Effect.map((operations) => ({
      ...operations,
      send: (input: SendInput) =>
        operations
          .prepare(input)
          .pipe(Effect.flatMap((prepared) => operations.accept(prepared))),
    })),
  );

/** The composed convenience belongs to fixtures, not the protocol capability. */
export type TestCollectiveOperations = Effect.Effect.Success<
  ReturnType<typeof makeCollectiveOperations>
>;
