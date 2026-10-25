/** @file Caller-bound authenticated cursor encoding for volatile Router polling. */
import { type AgentId, AgentId as AgentIdSchema } from "@moltzap/client";
import { routerContract } from "@moltzap/client/internal";
import canonicalize from "canonicalize";
import { Data, Effect, Encoding, Schema } from "effect";
import { compactDecrypt, CompactEncrypt } from "jose";
import { createSecretKey } from "node:crypto";
import { maximumPrivateOrder } from "./feed.js";

/** Cursor construction failed before a result could be returned. */
class PollCursorEncryptionError extends Data.TaggedError(
  "PollCursorEncryptionError",
) {}

/** A cursor does not authenticate for this caller and process. */
class PollCursorInvalidError extends Data.TaggedError(
  "PollCursorInvalidError",
) {}

/** Authenticated current-process cursor operations. */
export interface PollCursorCodec {
  readonly encrypt: (input: {
    readonly agentId: AgentId;
    readonly lastScannedOrder: bigint;
  }) => Effect.Effect<
    typeof routerContract.PollCursor.Type,
    PollCursorEncryptionError
  >;
  readonly decrypt: (
    cursor: typeof routerContract.PollCursor.Type,
    callerAgentId: AgentId,
  ) => Effect.Effect<bigint, PollCursorInvalidError>;
}

/**
 * Creates the current-instance authenticated client-held cursor codec. The
 * key is imported once as a non-extractable AES-GCM `CryptoKey`, so no
 * encrypt or decrypt imports raw key bytes.
 *
 * @param input Process-local key and instance identity.
 * @param input.key Process-local direct encryption key.
 * @param input.routerInstanceId Current volatile process identity.
 * @returns A caller-bound cursor codec.
 */
export const makePollCursorCodec = (input: {
  readonly key: Uint8Array;
  readonly routerInstanceId: typeof routerContract.RouterInstanceId.Type;
}): PollCursorCodec => {
  const key = createSecretKey(new Uint8Array(input.key)).toCryptoKey(
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  const routerInstanceId = input.routerInstanceId;
  return Object.freeze({
    encrypt: ({
      agentId,
      lastScannedOrder,
    }: {
      readonly agentId: AgentId;
      readonly lastScannedOrder: bigint;
    }) => encodePollCursor(key, routerInstanceId, agentId, lastScannedOrder),
    decrypt: (
      cursor: typeof routerContract.PollCursor.Type,
      callerAgentId: AgentId,
    ) => decodePollCursor(key, routerInstanceId, cursor, callerAgentId),
  });
};

/**
 * Generates one process-local random Router instance identity.
 *
 * @returns A fresh random instance identifier.
 */
export const generateRouterInstanceId =
  (): typeof routerContract.RouterInstanceId.Type =>
    Schema.decodeUnknownSync(routerContract.RouterInstanceId)(
      `rti_${Encoding.encodeBase64Url(
        globalThis.crypto.getRandomValues(
          new Uint8Array(routerContract.routerInstanceIdByteLength),
        ),
      )}`,
    );

/**
 * Generates the process-local direct A256GCM key.
 *
 * @returns A fresh random 256-bit key.
 */
export const generatePollCursorKey = (): Uint8Array =>
  globalThis.crypto.getRandomValues(new Uint8Array(32));

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

const orderText = Schema.String.pipe(
  Schema.pattern(/^(?:0|[1-9]\d*)$/),
  Schema.filter((value) => BigInt(value) <= maximumPrivateOrder),
);

const cursorPlaintext = Schema.Struct({
  agentId: AgentIdSchema,
  routerInstanceId: routerContract.RouterInstanceId,
  lastScannedOrder: orderText,
}).annotations({
  parseOptions: {
    exact: true,
    onExcessProperty: "error",
  },
});

const canonicalPlaintext = (input: {
  readonly agentId: AgentId;
  readonly routerInstanceId: typeof routerContract.RouterInstanceId.Type;
  readonly lastScannedOrder: bigint;
}): string | undefined =>
  canonicalize({
    agentId: input.agentId,
    routerInstanceId: input.routerInstanceId,
    lastScannedOrder: input.lastScannedOrder.toString(10),
  });

const invalidCursor = () => new PollCursorInvalidError();

function encodePollCursor(
  key: CryptoKey,
  routerInstanceId: typeof routerContract.RouterInstanceId.Type,
  agentId: AgentId,
  lastScannedOrder: bigint,
): Effect.Effect<
  typeof routerContract.PollCursor.Type,
  PollCursorEncryptionError
> {
  return Effect.gen(function* () {
    if (lastScannedOrder < 0n || lastScannedOrder > maximumPrivateOrder) {
      return yield* Effect.fail(new PollCursorEncryptionError());
    }
    const plaintext = canonicalPlaintext({
      agentId,
      routerInstanceId,
      lastScannedOrder,
    });
    if (plaintext === undefined) {
      return yield* Effect.fail(new PollCursorEncryptionError());
    }
    const compact = yield* Effect.tryPromise({
      try: () =>
        new CompactEncrypt(utf8Encoder.encode(plaintext))
          .setProtectedHeader(routerContract.pollCursorProtectedHeader)
          .encrypt(key),
      catch: () => new PollCursorEncryptionError(),
    });
    return yield* Schema.decodeUnknown(routerContract.PollCursor)(
      `${routerContract.pollCursorPrefix}${compact}`,
    ).pipe(
      Effect.catchTag("ParseError", () =>
        Effect.fail(new PollCursorEncryptionError()),
      ),
    );
  });
}

const plaintextIsCurrent = (input: {
  readonly canonical: string;
  readonly text: string;
  readonly agentId: AgentId;
  readonly callerAgentId: AgentId;
  readonly routerInstanceId: typeof routerContract.RouterInstanceId.Type;
  readonly currentRouterInstanceId: typeof routerContract.RouterInstanceId.Type;
}): boolean => {
  if (input.canonical !== input.text) {
    return false;
  }
  return (
    input.agentId === input.callerAgentId &&
    input.routerInstanceId === input.currentRouterInstanceId
  );
};

type CursorPlaintext = typeof cursorPlaintext.Type;

const decodeCursorPlaintext = (
  text: string,
): Effect.Effect<CursorPlaintext, PollCursorInvalidError> =>
  Schema.decodeUnknown(Schema.parseJson(cursorPlaintext))(text, {
    exact: true,
    onExcessProperty: "error",
  }).pipe(Effect.catchTag("ParseError", () => Effect.fail(invalidCursor())));

function decodePollCursor(
  key: CryptoKey,
  routerInstanceId: typeof routerContract.RouterInstanceId.Type,
  cursor: typeof routerContract.PollCursor.Type,
  callerAgentId: AgentId,
): Effect.Effect<bigint, PollCursorInvalidError> {
  return Effect.gen(function* () {
    const compact = cursor.slice(routerContract.pollCursorPrefix.length);
    if (
      compact.split(".", 1)[0] !==
      routerContract.encodedPollCursorProtectedHeader
    ) {
      return yield* Effect.fail(invalidCursor());
    }
    const decrypted = yield* Effect.tryPromise({
      try: () => compactDecrypt(compact, key),
      catch: invalidCursor,
    });
    const text = yield* Effect.try({
      try: () => utf8Decoder.decode(decrypted.plaintext),
      catch: invalidCursor,
    });
    const value = yield* decodeCursorPlaintext(text);
    const canonical = canonicalize({
      agentId: value.agentId,
      routerInstanceId: value.routerInstanceId,
      lastScannedOrder: value.lastScannedOrder,
    });
    if (
      canonical === undefined ||
      !plaintextIsCurrent({
        canonical,
        text,
        agentId: value.agentId,
        callerAgentId,
        routerInstanceId: value.routerInstanceId,
        currentRouterInstanceId: routerInstanceId,
      })
    ) {
      return yield* Effect.fail(invalidCursor());
    }
    return BigInt(value.lastScannedOrder);
  });
}
