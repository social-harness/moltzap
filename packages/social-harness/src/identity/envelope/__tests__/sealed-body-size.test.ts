/** @file SealedBody exact sizes, size limits, and size refusals. */

import { Effect, Either, Option } from "effect";
import * as fc from "fast-check";
import { expect, it } from "vitest";
import { SealedBody } from "../sealed-body.js";
import { SignedMessageSigningError } from "../signed-message.js";
import {
  type Group,
  KEY_AGREEMENT_HEAVY_TIMEOUT_MS,
  makeGroup,
  openAs,
  sealFrom,
  signBody,
} from "./sealed-body-fixtures.js";

const SIGNED_MESSAGE_BODY_CAP = 262_144;

/**
 * Seals `bytes` from the sender to the group, then checks that the peer opens
 * exactly `bytes` and that `sealedByteLength` reports the sealed length.
 *
 * @param group Sender, peer, and recipients.
 * @param bytes Plaintext to seal.
 * @returns Completion once both checks pass.
 */
const expectExactRoundTrip = (group: Group, bytes: Uint8Array) =>
  Effect.gen(function* () {
    const sealed = yield* sealFrom(group.sender, group.recipients, bytes);
    const signedMessage = yield* signBody(
      group.sender,
      group.recipients,
      sealed,
    );

    expect(yield* openAs(group.peer, signedMessage)).toEqual(bytes);
    expect(
      SealedBody.sealedByteLength({
        plaintextByteLength: bytes.byteLength,
        recipientCount: group.recipients.length,
      }),
    ).toStrictEqual(Option.some(sealed.byteLength));
  });

/**
 * Runs `expectExactRoundTrip` over generated plaintexts of 0 to 2,048 bytes,
 * always including the empty plaintext, whose salted form is exactly the salt
 * and so sits on the boundary of the short-plaintext refusal.
 *
 * @param group Sender, peer, and recipients.
 * @returns The fast-check run, rejecting with the shrunk counterexample.
 */
const generatedPlaintextsRoundTrip = (group: Group) =>
  fc.assert(
    fc.asyncProperty(fc.uint8Array({ maxLength: 2048 }), (bytes) =>
      Effect.runPromise(expectExactRoundTrip(group, bytes)),
    ),
    { numRuns: 16, examples: [[new Uint8Array()]] },
  );

it(
  "opens every generated plaintext exactly and seals it to the reported length",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const group = yield* makeGroup(3);
        yield* Effect.tryPromise({
          try: () => generatedPlaintextsRoundTrip(group),
          catch: (counterexample) => counterexample,
        });
      }),
    ),
  KEY_AGREEMENT_HEAVY_TIMEOUT_MS,
);

it.each([1, 2, 32, 128])(
  "seals and opens the reported largest plaintext for %i recipients within the body cap, and one more byte exceeds it",
  (recipientCount) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const group = yield* makeGroup(recipientCount);
        const largestPlaintextBytes = Option.getOrThrow(
          SealedBody.maximumPlaintextByteLength(recipientCount),
        );

        const largest = yield* sealFrom(
          group.sender,
          group.recipients,
          new Uint8Array(largestPlaintextBytes),
        );
        const oneMore = yield* sealFrom(
          group.sender,
          group.recipients,
          new Uint8Array(largestPlaintextBytes + 1),
        );
        const signedMessage = yield* signBody(
          group.sender,
          group.recipients,
          largest,
        );

        expect((yield* openAs(group.sender, signedMessage)).byteLength).toBe(
          largestPlaintextBytes,
        );
        expect(largest.byteLength).toBeLessThanOrEqual(SIGNED_MESSAGE_BODY_CAP);
        expect(oneMore.byteLength).toBeGreaterThan(SIGNED_MESSAGE_BODY_CAP);
        expect(
          yield* signBody(group.sender, group.recipients, oneMore).pipe(
            Effect.either,
          ),
        ).toStrictEqual(Either.left(new SignedMessageSigningError()));
        expect(
          SealedBody.sealedByteLength({
            plaintextByteLength: largestPlaintextBytes,
            recipientCount,
          }),
        ).toStrictEqual(Option.some(largest.byteLength));
      }),
    ),
  KEY_AGREEMENT_HEAVY_TIMEOUT_MS,
);

it.each([
  { plaintextByteLength: 0, recipientCount: 0 },
  { plaintextByteLength: 0, recipientCount: 129 },
  { plaintextByteLength: 0, recipientCount: 1.5 },
  { plaintextByteLength: -1, recipientCount: 1 },
  { plaintextByteLength: 0.5, recipientCount: 1 },
  { plaintextByteLength: Number.MAX_SAFE_INTEGER, recipientCount: 1 },
])(
  "reports no sealed length for $plaintextByteLength plaintext bytes to $recipientCount recipients",
  (input) => {
    expect(SealedBody.sealedByteLength(input)).toStrictEqual(Option.none());
  },
);

it.each([0, 129, 2.5])(
  "reports no largest plaintext for %d recipients",
  (recipientCount) => {
    expect(SealedBody.maximumPlaintextByteLength(recipientCount)).toStrictEqual(
      Option.none(),
    );
  },
);
