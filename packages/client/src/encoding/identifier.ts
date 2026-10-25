/** @file Canonical identifier text and deterministic byte and ASCII ordering. */

import { Array, Either, Encoding, Schema } from "effect";

const HASH_BYTE_LENGTH = 32;

/**
 * Decode base64url only in its canonical encoding, so one key has one text form.
 * @param value The base64url text.
 * @returns The bytes, or undefined when the text is not canonical base64url.
 */
export const decodeCanonicalBase64Url = (
  value: string,
): Uint8Array | undefined =>
  Either.match(Encoding.decodeBase64Url(value), {
    onLeft: () => undefined,
    onRight: (bytes) =>
      Encoding.encodeBase64Url(bytes) === value ? bytes : undefined,
  });

/**
 * Whether a value is the prefix followed by the canonical base64url of a
 * 32-byte hash, the shape of every minted Social Harness identifier.
 * @param prefix The identifier's kind prefix, such as `pst_`.
 * @param value The candidate identifier.
 * @returns Whether the value is canonical for that prefix.
 */
export function isCanonicalIdentifier(prefix: string, value: string): boolean {
  if (!value.startsWith(prefix)) {
    return false;
  }
  return (
    decodeCanonicalBase64Url(value.slice(prefix.length))?.byteLength ===
    HASH_BYTE_LENGTH
  );
}

/**
 * Order agent ids by their decoded key bytes, the order membership
 * descriptors and group addresses use.
 * @param left One agent id.
 * @param right The other agent id.
 * @returns A negative, zero, or positive comparison result.
 */
export const compareAgentIds = (left: string, right: string): number => {
  const leftBytes = decodeCanonicalBase64Url(left.slice(4));
  const rightBytes = decodeCanonicalBase64Url(right.slice(4));
  if (leftBytes === undefined || rightBytes === undefined) {
    return 0;
  }
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftBytes.byteLength - rightBytes.byteLength;
};

/**
 * Unsigned ASCII order, the order a canonical group address lists its names in.
 * @param left One name.
 * @param right The other name.
 * @returns Negative, zero, or positive as `left` sorts before, with, or after `right`.
 */
export const compareAscii = (left: string, right: string): number => {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
};

/** Require each adjacent pair to increase strictly, rejecting duplicates and missing entries. */
export function isStrictlyAscending<Value>(
  values: readonly Value[],
  compare: (left: Value, right: Value) => number,
): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (
      previous === undefined ||
      current === undefined ||
      compare(previous, current) >= 0
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Tests whether a string is the unique base64url encoding of a fixed byte length.
 *
 * @param value Candidate unpadded base64url text.
 * @param byteLength Required decoded byte length.
 * @returns Whether the candidate has the one canonical encoding for that length.
 */
export const hasCanonicalBase64UrlLength = (
  value: string,
  byteLength: number,
): boolean => decodeCanonicalBase64Url(value)?.byteLength === byteLength;

/**
 * Constructs one exact prefixed identity Schema for its semantic owner.
 * The pattern preserves byte length and zero padding bits in runtime
 * validation and JSON Schema projections.
 *
 * @param name Nominal Schema and brand name.
 * @param prefix Fixed representation prefix.
 * @param byteLength Required decoded payload length.
 * @returns The exact branded string Schema.
 */
export const canonicalIdentifier = <const Name extends string>(
  name: Name,
  prefix: string,
  byteLength: number,
) => {
  const wholeCharacters = Math.floor((byteLength * 8) / 6);
  const remainingBits = (byteLength * 8) % 6;
  const finalCharacter =
    remainingBits === 0
      ? ""
      : `[${Array.makeBy(2 ** remainingBits, (value) =>
          Encoding.encodeBase64Url(
            Uint8Array.of(value << (8 - remainingBits)),
          ).charAt(0),
        ).join("")}]`;
  const pattern = new RegExp(
    `^${prefix}[A-Za-z0-9_-]{${wholeCharacters}}${finalCharacter}$`,
    "u",
  );
  return Schema.String.pipe(
    Schema.length(prefix.length + Math.ceil((byteLength * 8) / 6)),
    Schema.pattern(pattern),
    Schema.brand(name),
    Schema.annotations({
      identifier: name,
      description: `${name} canonical representation`,
    }),
  );
};
