/** @file Shared canonical JSON parsing and encoding for signed and stored representations. */

import canonicalize from "canonicalize";
import { Data, Effect, Schema } from "effect";
import { types as nodeTypes } from "node:util";

import { exactParseOptions } from "./exact.js";

const MAXIMUM_CONTAINER_DEPTH = 16;
const MAXIMUM_ARRAY_INDEX = 4_294_967_294;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const utf8Encoder = new TextEncoder();
const createObject = Object.create;
const defineProperty = Object.defineProperty;
const freezeObject = Object.freeze;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const numberFrom = Number;
const numberIsFinite = Number.isFinite;
const numberIsInteger = Number.isInteger;
const ownKeys = Reflect.ownKeys;

/* eslint-disable agent-code-guard/no-nullish-type-aliases -- JSON null is a value, not an optional absence, in this domain. */
type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
/* eslint-enable agent-code-guard/no-nullish-type-aliases -- Restore the absence rule outside the JSON-domain alias. */

type JsonSnapshot =
  | Readonly<{ valid: false }>
  | Readonly<{ valid: true; value: JsonValue }>;

const invalidJsonSnapshot = (): JsonSnapshot => ({ valid: false });

const validJsonSnapshot = (value: JsonValue): JsonSnapshot => ({
  valid: true,
  value,
});

const isHighSurrogate = (codeUnit: number): boolean =>
  codeUnit >= 0xd800 && codeUnit <= 0xdbff;

const isLowSurrogate = (codeUnit: number): boolean =>
  codeUnit >= 0xdc00 && codeUnit <= 0xdfff;

const hasWellFormedUnicode = (value: string): boolean => {
  if (typeof value !== "string") {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (isLowSurrogate(codeUnit)) {
      return false;
    }
    if (!isHighSurrogate(codeUnit)) {
      continue;
    }
    index += 1;
    if (index >= value.length || !isLowSurrogate(value.charCodeAt(index))) {
      return false;
    }
  }
  return true;
};

type JsonSnapshotContext = Readonly<{
  containerDepth: number;
  ancestors: Set<object>;
}>;

type JsonSnapshotVisitor = (
  value: unknown,
  context: JsonSnapshotContext,
) => JsonSnapshot;

/**
 * The pinned canonicalizer resolves these properties from the ambient realm.
 * Recording their descriptors before any input arrives lets canonicalization
 * fail closed if in-process code replaces one of them.
 */
type CanonicalizerDependency =
  | Readonly<{
      descriptorFound: false;
      owner: object;
      property: PropertyKey;
    }>
  | Readonly<{
      descriptor: PropertyDescriptor;
      descriptorFound: true;
      owner: object;
      property: PropertyKey;
    }>;

const arrayConstructor = Array;
const arrayIsArray = Array.isArray;
const arrayPrototype = Array.prototype;
const jsonObject = JSON;
const objectConstructor = Object;
const objectPrototype = Object.prototype;
const setConstructor = Set;
const setPrototype = Set.prototype;

const isPlainRecord = (value: object): boolean => {
  const prototype: unknown = getPrototypeOf(value);
  return prototype === objectPrototype || prototype === null;
};

const findArrayIteratorPrototype = (): object => {
  const candidate: unknown = getPrototypeOf([][Symbol.iterator]());
  if (candidate === null || typeof candidate !== "object") {
    return objectPrototype;
  }
  return candidate;
};
const arrayIteratorPrototype = findArrayIteratorPrototype();

const captureCanonicalizerDependency = (
  owner: object,
  property: PropertyKey,
): CanonicalizerDependency => {
  const descriptor = getOwnPropertyDescriptor(owner, property);
  const dependency: CanonicalizerDependency =
    descriptor === undefined
      ? { descriptorFound: false, owner, property }
      : {
          descriptor,
          descriptorFound: true,
          owner,
          property,
        };
  return freezeObject(dependency);
};

const canonicalizerDependencies: readonly CanonicalizerDependency[] = [
  captureCanonicalizerDependency(globalThis, "Array"),
  captureCanonicalizerDependency(arrayConstructor, "isArray"),
  captureCanonicalizerDependency(arrayConstructor, "prototype"),
  captureCanonicalizerDependency(arrayConstructor, Symbol.species),
  captureCanonicalizerDependency(arrayPrototype, "constructor"),
  captureCanonicalizerDependency(arrayPrototype, Symbol.iterator),
  captureCanonicalizerDependency(arrayPrototype, "join"),
  captureCanonicalizerDependency(arrayPrototype, "map"),
  captureCanonicalizerDependency(arrayPrototype, "push"),
  captureCanonicalizerDependency(arrayPrototype, "sort"),
  captureCanonicalizerDependency(arrayIteratorPrototype, "next"),
  captureCanonicalizerDependency(globalThis, "isFinite"),
  captureCanonicalizerDependency(globalThis, "isNaN"),
  captureCanonicalizerDependency(globalThis, "JSON"),
  captureCanonicalizerDependency(jsonObject, "parse"),
  captureCanonicalizerDependency(jsonObject, "stringify"),
  captureCanonicalizerDependency(globalThis, "Object"),
  captureCanonicalizerDependency(objectConstructor, "keys"),
  captureCanonicalizerDependency(objectConstructor, "prototype"),
  captureCanonicalizerDependency(globalThis, "Set"),
  captureCanonicalizerDependency(setConstructor, "prototype"),
  captureCanonicalizerDependency(setPrototype, "add"),
  captureCanonicalizerDependency(setPrototype, "delete"),
  captureCanonicalizerDependency(setPrototype, "has"),
];

const hasMatchingDataDescriptor = (
  current: PropertyDescriptor,
  expected: PropertyDescriptor,
): boolean => {
  if (!("value" in current) || !("value" in expected)) {
    return false;
  }
  return (
    current.value === expected.value && current.writable === expected.writable
  );
};

const hasMatchingAccessorDescriptor = (
  current: PropertyDescriptor,
  expected: PropertyDescriptor,
): boolean => {
  if ("value" in current || "value" in expected) {
    return false;
  }
  return current.get === expected.get && current.set === expected.set;
};

const hasExpectedDescriptor = (
  dependency: CanonicalizerDependency,
): boolean => {
  if (!dependency.descriptorFound) {
    return false;
  }
  const current = getOwnPropertyDescriptor(
    dependency.owner,
    dependency.property,
  );
  if (current === undefined) {
    return false;
  }
  if (
    current.configurable !== dependency.descriptor.configurable ||
    current.enumerable !== dependency.descriptor.enumerable
  ) {
    return false;
  }
  return "value" in dependency.descriptor
    ? hasMatchingDataDescriptor(current, dependency.descriptor)
    : hasMatchingAccessorDescriptor(current, dependency.descriptor);
};

const hasExpectedCanonicalizerPrototypeChain = (): boolean => {
  if (getOwnPropertyDescriptor(arrayPrototype, "toJSON") !== undefined) {
    return false;
  }
  if (getOwnPropertyDescriptor(objectPrototype, "toJSON") !== undefined) {
    return false;
  }
  if (getPrototypeOf(arrayPrototype) !== objectPrototype) {
    return false;
  }
  if (getPrototypeOf(objectPrototype) !== null) {
    return false;
  }
  return getPrototypeOf(setPrototype) === objectPrototype;
};

const isArrayIndexName = (key: string): boolean => {
  const numericKey = numberFrom(key);
  if (!numberIsInteger(numericKey)) {
    return false;
  }
  if (numericKey < 0 || numericKey > MAXIMUM_ARRAY_INDEX) {
    return false;
  }
  return `${numericKey}` === key;
};

const hasIndexedPrototypeProperty = (prototype: object): boolean => {
  const keys = ownKeys(prototype);
  let index = 0;
  while (index < keys.length) {
    const key = keys[index];
    if (typeof key === "string" && isArrayIndexName(key)) {
      return true;
    }
    index += 1;
  }
  return false;
};

const canonicalizeRuntimeIsIntact = (): boolean => {
  let index = 0;
  // Index traversal cannot be bypassed by replacing the iterator that the
  // canonicalizer itself uses.
  while (index < canonicalizerDependencies.length) {
    const dependency = canonicalizerDependencies[index];
    if (dependency === undefined || !hasExpectedDescriptor(dependency)) {
      return false;
    }
    index += 1;
  }
  if (!hasExpectedCanonicalizerPrototypeChain()) {
    return false;
  }
  // The canonicalizer creates ordinary arrays through assignment and push,
  // so inherited index properties could intercept its internal writes.
  if (hasIndexedPrototypeProperty(arrayPrototype)) {
    return false;
  }
  return !hasIndexedPrototypeProperty(objectPrototype);
};

const readArrayLength = (value: readonly unknown[]): number | undefined => {
  const descriptor = getOwnPropertyDescriptor(value, "length");
  if (descriptor === undefined) {
    return undefined;
  }
  if (descriptor.enumerable === true || !("value" in descriptor)) {
    return undefined;
  }
  return typeof descriptor.value === "number" ? descriptor.value : undefined;
};

const snapshotJsonArray = (
  value: readonly unknown[],
  context: JsonSnapshotContext,
  visit: JsonSnapshotVisitor,
): JsonSnapshot => {
  const length = readArrayLength(value);
  if (length === undefined) {
    return invalidJsonSnapshot();
  }
  // Parsed JSON arrays own only length and one enumerable data property
  // per index, so other shapes never reach the canonicalizer.
  if (ownKeys(value).length !== length + 1) {
    return invalidJsonSnapshot();
  }
  const snapshot: JsonValue[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      return invalidJsonSnapshot();
    }
    const item = visit(descriptor.value, context);
    if (!item.valid) {
      return invalidJsonSnapshot();
    }
    defineProperty(snapshot, String(index), {
      configurable: false,
      enumerable: true,
      value: item.value,
      writable: false,
    });
  }
  return validJsonSnapshot(freezeObject(snapshot));
};

const snapshotJsonRecord = (
  value: object,
  context: JsonSnapshotContext,
  visit: JsonSnapshotVisitor,
): JsonSnapshot => {
  // eslint-disable-next-line agent-code-guard/require-assertion-rationale -- Object.create(null) produces the exact string-indexed record populated only through validated data descriptors below.
  const snapshot: { [key: string]: JsonValue } = createObject(null) as {
    [key: string]: JsonValue;
  };
  const keys = ownKeys(value);
  let index = 0;
  // Index traversal keeps validation independent of ambient array iteration.
  while (index < keys.length) {
    const key = keys[index];
    if (typeof key !== "string" || !hasWellFormedUnicode(key)) {
      return invalidJsonSnapshot();
    }
    const descriptor = getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      return invalidJsonSnapshot();
    }
    const member = visit(descriptor.value, context);
    if (!member.valid) {
      return invalidJsonSnapshot();
    }
    defineProperty(snapshot, key, {
      configurable: false,
      enumerable: true,
      value: member.value,
      writable: false,
    });
    index += 1;
  }
  return validJsonSnapshot(freezeObject(snapshot));
};

const snapshotJsonContainer = (
  value: object,
  context: JsonSnapshotContext,
  visit: JsonSnapshotVisitor,
): JsonSnapshot => {
  const nextDepth = context.containerDepth + 1;
  // A Proxy can execute arbitrary code during reflection, so it is not a
  // JSON data container and fails before any trap is consulted.
  if (
    nextDepth > MAXIMUM_CONTAINER_DEPTH ||
    context.ancestors.has(value) ||
    nodeTypes.isProxy(value)
  ) {
    return invalidJsonSnapshot();
  }
  context.ancestors.add(value);
  const nestedContext = { ...context, containerDepth: nextDepth };
  try {
    if (arrayIsArray(value)) {
      return snapshotJsonArray(value, nestedContext, visit);
    }
    return isPlainRecord(value)
      ? snapshotJsonRecord(value, nestedContext, visit)
      : invalidJsonSnapshot();
  } finally {
    context.ancestors.delete(value);
  }
};

const visitJsonValue: JsonSnapshotVisitor = (value, context) => {
  if (value === null || typeof value === "boolean") {
    return validJsonSnapshot(value);
  }
  if (typeof value === "number") {
    return numberIsFinite(value)
      ? validJsonSnapshot(value)
      : invalidJsonSnapshot();
  }
  if (typeof value === "string") {
    return hasWellFormedUnicode(value)
      ? validJsonSnapshot(value)
      : invalidJsonSnapshot();
  }
  return typeof value === "object"
    ? snapshotJsonContainer(value, context, visitJsonValue)
    : invalidJsonSnapshot();
};

const snapshotJsonValue = (root: unknown): JsonSnapshot => {
  // Callers can supply hostile reflection traps. Snapshotting converts
  // those inputs into either inert data or an ordinary validation failure.
  try {
    return visitJsonValue(root, {
      ancestors: new Set(),
      containerDepth: 0,
    });
    // eslint-disable-next-line agent-code-guard/bare-catch -- The snapshot boundary converts hostile reflection into ordinary validation failure.
  } catch {
    return invalidJsonSnapshot();
  }
};

const jsonValueSchema = Schema.Unknown.pipe(
  Schema.filter((value) => snapshotJsonValue(value).valid, {
    identifier: "CanonicalJsonValue",
    description:
      "JSON value with well-formed Unicode and bounded container depth",
  }),
);
const jsonTextSchema = Schema.parseJson(jsonValueSchema);

/** Canonical JSON decoding or encoding failed without exposing its cause. */
export class CanonicalJsonError extends Data.TaggedError(
  "CanonicalJsonError",
) {}

const canonicalJsonBytes = (
  value: unknown,
): Effect.Effect<Uint8Array, CanonicalJsonError> =>
  Effect.try({
    try: () => {
      return canonicalizeRuntimeIsIntact() ? canonicalize(value) : undefined;
    },
    catch: () => new CanonicalJsonError(),
  }).pipe(
    Effect.flatMap((text) =>
      text === undefined
        ? Effect.fail(new CanonicalJsonError())
        : Effect.succeed(utf8Encoder.encode(text)),
    ),
  );

// eslint-disable-next-line @typescript-eslint/unbound-method -- Capturing the intrinsic prevents candidate arrays from replacing the comparison method.
const everyByte = Uint8Array.prototype.every;

/** Compares complete byte sequences, rejecting detached or exotic typed arrays. */
export const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  try {
    return (
      everyByte.call(left, (byte, index) => byte === right[index]) &&
      everyByte.call(right, (byte, index) => byte === left[index])
    );
    // eslint-disable-next-line agent-code-guard/bare-catch -- Detached or exotic typed arrays are non-canonical inputs, not defects.
  } catch {
    return false;
  }
};

/**
 * Parses already-bounded bytes and returns a value only when the original
 * bytes are the value's canonical UTF-8 representation.
 *
 * @param bytes Bounded candidate representation.
 * @returns The parsed JSON value.
 * @failure CanonicalJsonError when UTF-8, JSON, domain, or canonical-byte
 * validation fails.
 */
export const parseCanonicalJson = (
  bytes: Uint8Array,
): Effect.Effect<JsonValue, CanonicalJsonError> =>
  Effect.gen(function* () {
    if (!canonicalizeRuntimeIsIntact()) {
      return yield* new CanonicalJsonError();
    }
    const text = yield* Effect.try({
      try: () => utf8Decoder.decode(bytes),
      catch: () => new CanonicalJsonError(),
    });
    const parsed = yield* Schema.decodeUnknown(jsonTextSchema)(text).pipe(
      Effect.catchTag("ParseError", () =>
        Effect.fail(new CanonicalJsonError()),
      ),
    );
    const snapshot = snapshotJsonValue(parsed);
    if (!snapshot.valid) {
      return yield* new CanonicalJsonError();
    }
    const value = snapshot.value;
    const encoded = yield* canonicalJsonBytes(value);
    if (!sameBytes(bytes, encoded)) {
      return yield* new CanonicalJsonError();
    }
    return value;
  }).pipe(Effect.withSpan("parseCanonicalJson"));

/**
 * Decodes canonical JSON bytes through one exact domain Schema.
 *
 * @param schema Closed domain Schema.
 * @param bytes Bounded canonical JSON bytes.
 * @returns The decoded domain value.
 * @failure CanonicalJsonError when representation or domain validation fails.
 */
export const decodeCanonicalJson = <A, I, R>(
  schema: Schema.Schema<A, I, R>,
  bytes: Uint8Array,
): Effect.Effect<A, CanonicalJsonError, R> =>
  parseCanonicalJson(bytes).pipe(
    Effect.flatMap(
      Schema.decodeUnknown(schema, {
        exact: true,
        onExcessProperty: "error",
      }),
    ),
    Effect.catchTag("ParseError", () => Effect.fail(new CanonicalJsonError())),
  );

/**
 * Encodes a JSON-domain value as canonical UTF-8 bytes.
 *
 * @param value Candidate JSON-domain value.
 * @returns Canonical UTF-8 bytes.
 * @failure CanonicalJsonError when the value is outside the JSON domain.
 */
export const encodeCanonicalJson = (
  value: unknown,
): Effect.Effect<Uint8Array, CanonicalJsonError> =>
  Effect.sync(() => {
    if (!canonicalizeRuntimeIsIntact()) {
      return invalidJsonSnapshot();
    }
    return snapshotJsonValue(value);
  }).pipe(
    Effect.flatMap((snapshot) =>
      snapshot.valid
        ? canonicalJsonBytes(snapshot.value)
        : Effect.fail(new CanonicalJsonError()),
    ),
  );

/** A Client-owned representation, hash, or verification check failed. */
export class ClientRepresentationError extends Data.TaggedError(
  "ClientRepresentationError",
) {}

/** Discard decoder and encoder diagnostics at the representation boundary. */
export const representationFailure = (): ClientRepresentationError =>
  new ClientRepresentationError();

/** Encode JSON as canonical UTF-8, rejecting values with no JSON representation. */
export const canonicalBytes = (
  value: unknown,
): Effect.Effect<Uint8Array, ClientRepresentationError> =>
  canonicalJsonBytes(value).pipe(Effect.mapError(representationFailure));

/** Encode one closed value into its unique JCS UTF-8 representation. */
export const encodeCanonical = <A, I, R>(
  schema: Schema.Schema<A, I, R>,
  value: A,
): Effect.Effect<Uint8Array, ClientRepresentationError, R> =>
  Schema.encode(schema)(value).pipe(
    Effect.mapError(representationFailure),
    Effect.flatMap(canonicalBytes),
  );

/** Decode one closed value only when its input bytes are already exact JCS. */
export const decodeCanonical = <A, I, R>(
  schema: Schema.Schema<A, I, R>,
  bytes: Uint8Array,
): Effect.Effect<A, ClientRepresentationError, R> =>
  Effect.gen(function* () {
    const text = yield* Effect.try({
      try: () => utf8Decoder.decode(bytes),
      catch: representationFailure,
    });
    const decoded = yield* Schema.decodeUnknown(Schema.parseJson(schema))(
      text,
      exactParseOptions,
    ).pipe(Effect.mapError(representationFailure));
    const canonical = yield* encodeCanonical(schema, decoded);
    if (!sameBytes(bytes, canonical)) {
      return yield* representationFailure();
    }
    return decoded;
  }).pipe(Effect.withSpan("decodeCanonical"));

/** Whether two values of one schema have the same canonical bytes. */
export const equalCanonical = <A, I, R>(
  schema: Schema.Schema<A, I, R>,
  left: A,
  right: A,
): Effect.Effect<boolean, ClientRepresentationError, R> =>
  Effect.all([
    encodeCanonical(schema, left),
    encodeCanonical(schema, right),
  ]).pipe(
    Effect.map(([leftBytes, rightBytes]) => sameBytes(leftBytes, rightBytes)),
  );
