/** @file Canonical JSON exactness, hostile-input, realm-integrity, and bounds tests. */

import { Effect, Either, Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decodeCanonicalJson,
  encodeCanonicalJson,
  parseCanonicalJson,
} from "../canonical-json.js";

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

const succeeds = <A, E>(effect: Effect.Effect<A, E>): boolean =>
  Either.match(Effect.runSync(Effect.either(effect)), {
    onLeft: () => false,
    onRight: () => true,
  });

const parses = (value: Uint8Array): boolean =>
  succeeds(parseCanonicalJson(value));

const encodes = (value: unknown): boolean =>
  succeeds(encodeCanonicalJson(value));

const nestedArray = (depth: number): string =>
  `${"[".repeat(depth)}0${"]".repeat(depth)}`;

const nestedObject = (depth: number): string => {
  let value = "0";
  for (let index = 0; index < depth; index += 1) {
    value = `{"a":${value}}`;
  }
  return value;
};

const CANONICAL_ARRAY_TEXT = "[1,2]";
const CANONICAL_OBJECT_TEXT = '{"a":1,"b":2}';
const ALTERNATE_OBJECT_TEXT = '{"b":2,"a":1}';

/* eslint-disable agent-code-guard/no-prototype-manipulation, no-extend-native --
 * This regression harness temporarily installs the exact ambient behavior the
 * canonical JSON boundary must detect, then restores every original descriptor.
 */
const withOwnPropertyDescriptor = <A>(
  owner: object,
  property: PropertyKey,
  descriptor: PropertyDescriptor,
  run: () => A,
): A => {
  const prior = Object.getOwnPropertyDescriptor(owner, property);
  const priorArrayLength =
    owner === Array.prototype
      ? Object.getOwnPropertyDescriptor(Array.prototype, "length")
      : undefined;
  Object.defineProperty(owner, property, {
    configurable: true,
    ...descriptor,
  });
  try {
    return run();
  } finally {
    if (prior === undefined) {
      Reflect.deleteProperty(owner, property);
    } else {
      Object.defineProperty(owner, property, prior);
    }
    if (priorArrayLength !== undefined) {
      Object.defineProperty(Array.prototype, "length", priorArrayLength);
    }
  }
};

const withArrayPrototypeParent = <A>(parent: object, run: () => A): A => {
  const prior: unknown = Object.getPrototypeOf(Array.prototype);
  if (prior !== null && typeof prior !== "object") {
    throw new Error("Array prototype parent is invalid");
  }
  Object.setPrototypeOf(Array.prototype, parent);
  try {
    return run();
  } finally {
    Object.setPrototypeOf(Array.prototype, prior);
  }
};

const findArrayIteratorPrototype = (): object => {
  const candidate: unknown = Object.getPrototypeOf([][Symbol.iterator]());
  if (candidate === null || typeof candidate !== "object") {
    throw new Error("Array iterator prototype is unavailable");
  }
  return candidate;
};
/* eslint-enable agent-code-guard/no-prototype-manipulation, no-extend-native --
 * Restore the production rule after the scoped ambient-behavior harness.
 */

const nonCanonicalTexts = [
  { caseName: "leading whitespace", text: ' {"a":1}' },
  { caseName: "trailing whitespace", text: '{"a":1} ' },
  { caseName: "alternate member order", text: '{"b":2,"a":1}' },
  { caseName: "duplicate member", text: '{"a":1,"a":2}' },
  { caseName: "decimal suffix", text: '{"a":1.0}' },
  { caseName: "exponent spelling", text: '{"a":1e0}' },
  { caseName: "negative zero", text: '{"a":-0}' },
  {
    caseName: "escaped ordinary Unicode",
    text: String.raw`{"a":"\u0061"}`,
  },
  { caseName: "trailing JSON value", text: '{"a":1}null' },
  { caseName: "byte-order mark", text: `\uFEFF{"a":1}` },
  {
    caseName: "unpaired surrogate",
    text: String.raw`{"a":"\ud800"}`,
  },
] as const;

describe("canonical identity JSON encoding", () => {
  it("encodes member order, Unicode, and numbers as canonical UTF-8", () => {
    const encoded = Effect.runSync(
      encodeCanonicalJson({ z: 1.0, text: "€", negativeZero: -0, a: true }),
    );
    expect(new TextDecoder().decode(encoded)).toBe(
      // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- This independent oracle fixes the required RFC 8785 spelling.
      '{"a":true,"negativeZero":0,"text":"€","z":1}',
    );
  });

  it("round-trips generated JSON through one stable canonical spelling", () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 4 }), (value) => {
        const firstEncoding = Effect.runSync(encodeCanonicalJson(value));
        const parsed = Effect.runSync(parseCanonicalJson(firstEncoding));
        const secondEncoding = Effect.runSync(encodeCanonicalJson(parsed));
        expect(secondEncoding).toEqual(firstEncoding);
      }),
    );
  });
});

describe("canonical identity JSON parsing", () => {
  it.each(nonCanonicalTexts)("rejects $caseName", ({ text }) => {
    expect(parses(utf8(text))).toBe(false);
  });

  it("rejects malformed UTF-8", () => {
    expect(parses(Uint8Array.of(0xc3, 0x28))).toBe(false);
  });
});

describe("canonical identity JSON value domain", () => {
  it("rejects values outside the JSON data model without invoking accessors", () => {
    let accessorInvoked = false;
    const accessor = {
      get value() {
        accessorInvoked = true;
        return 1;
      },
    };
    const symbolMember = { [Symbol("member")]: 1 };
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const sparseArray: unknown[] = [];
    sparseArray.length = 1;

    for (const value of [
      sparseArray,
      new Date(0),
      accessor,
      symbolMember,
      cyclic,
    ]) {
      expect(encodes(value)).toBe(false);
    }
    expect(accessorInvoked).toBe(false);
  });

  it("turns hostile reflection traps into a typed encoding failure", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("hostile");
        },
      },
    );

    expect(encodes(hostile)).toBe(false);
  });
});

// @agent-code-guard/regression-only: each case pins a concrete hostile-object boundary regression whose attack shape is the behavior under test
describe("canonical identity JSON hostile-input regressions", () => {
  it("rejects a proxy without consulting object behavior", () => {
    let toJsonReads = 0;
    const stateful = new Proxy(
      {},
      {
        get: (...[, key]): unknown => {
          if (key === "toJSON") {
            toJsonReads += 1;
            return () => "\ud800";
          }
          return undefined;
        },
        ownKeys: () => [],
      },
    );

    expect(encodes(stateful)).toBe(false);
    expect(toJsonReads).toBe(0);
  });

  it("does not delegate canonical-byte comparison to the candidate", () => {
    const alternateOrder = utf8('{"b":2,"a":1}');
    Object.defineProperty(alternateOrder, "every", {
      value: () => true,
    });

    expect(parses(alternateOrder)).toBe(false);
  });

  it("rejects an array proxy before consulting descriptor traps", () => {
    let descriptorReads = 0;
    const stateful = new Proxy([1], {
      getOwnPropertyDescriptor: (): never => {
        descriptorReads += 1;
        throw new Error("array descriptor read");
      },
    });

    expect(encodes(stateful)).toBe(false);
    expect(descriptorReads).toBe(0);
  });
});

// @agent-code-guard/regression-only: these cases pin fail-closed detection of ambient functions resolved by the canonicalization dependency
describe("canonical identity JSON ambient property lookup", () => {
  it("fails closed when arrays inherit toJSON behavior", () => {
    const result = withOwnPropertyDescriptor(
      Array.prototype,
      "toJSON",
      { value: () => "attacker" },
      () => ({
        encoded: encodes([1, 2]),
        parsed: parses(utf8(CANONICAL_ARRAY_TEXT)),
      }),
    );

    expect(result).toEqual({ encoded: false, parsed: false });
  });

  it("fails closed when object-key sorting changes", () => {
    const result = withOwnPropertyDescriptor(
      Array.prototype,
      "sort",
      { value: () => [] },
      () => ({
        encoded: encodes({ b: 2, a: 1 }),
        parsed: parses(utf8(CANONICAL_OBJECT_TEXT)),
      }),
    );

    expect(result).toEqual({ encoded: false, parsed: false });
  });
});

// @agent-code-guard/regression-only: these cases pin descriptor and prototype-chain bypasses that produced incorrect canonical bytes
describe("canonical identity JSON ambient descriptor integrity", () => {
  it("rejects a stateful sort accessor without invoking it", () => {
    const originalSort = Array.prototype.sort;
    let reads = 0;
    const result = withOwnPropertyDescriptor(
      Array.prototype,
      "sort",
      {
        get: () => {
          reads += 1;
          return reads === 1 ? originalSort : () => [];
        },
      },
      () => ({
        encoded: encodes({ b: 2, a: 1 }),
        parsed: parses(utf8(ALTERNATE_OBJECT_TEXT)),
      }),
    );

    expect(result).toEqual({ encoded: false, parsed: false });
    expect(reads).toBe(0);
  });

  it("fails closed when arrays inherit a new parent", () => {
    // eslint-disable-next-line agent-code-guard/require-assertion-rationale -- Object.create returns the exact ordinary parent object populated immediately below.
    const parent = Object.create(Object.prototype) as object;
    Object.defineProperty(parent, "toJSON", {
      value: () => "attacker",
    });

    const result = withArrayPrototypeParent(parent, () => encodes([1, 2]));

    expect(result).toBe(false);
  });
});

// @agent-code-guard/regression-only: these cases pin inherited numeric setters that silently dropped canonicalizer output
describe("canonical identity JSON ambient index properties", () => {
  it.each([
    { owner: Array.prototype, ownerName: "Array.prototype" },
    { owner: Object.prototype, ownerName: "Object.prototype" },
  ])("fails closed for an index setter on $ownerName", ({ owner }) => {
    const arrayPrototypeLength = Array.prototype.length;
    const input: number[] = [];
    const record: Record<string, number> = {};
    for (let index = 0; index <= 1_000; index += 1) {
      input.push(index);
      record[`k${String(index).padStart(4, "0")}`] = index;
    }
    let inheritedWrites = 0;
    const result = withOwnPropertyDescriptor(
      owner,
      "1000",
      {
        set: () => {
          inheritedWrites += 1;
        },
      },
      () => ({
        arrayEncoded: encodes(input),
        recordEncoded: encodes(record),
      }),
    );

    expect(result).toEqual({
      arrayEncoded: false,
      recordEncoded: false,
    });
    expect(inheritedWrites).toBe(0);
    expect(Array.prototype.length).toBe(arrayPrototypeLength);
  });
});

// @agent-code-guard/regression-only: these cases pin iterator and species bypasses that produced incorrect canonical bytes
describe("canonical identity JSON ambient iteration and allocation", () => {
  it("fails closed when array iteration changes", () => {
    const result = withOwnPropertyDescriptor(
      Array.prototype,
      Symbol.iterator,
      {
        value: () => ({
          next: () => ({ done: true, value: undefined }),
        }),
      },
      () => encodes({ a: 1 }),
    );

    expect(result).toBe(false);
  });

  it("fails closed when array iterator advancement changes", () => {
    const result = withOwnPropertyDescriptor(
      findArrayIteratorPrototype(),
      "next",
      { value: () => ({ done: true, value: undefined }) },
      () => encodes({ a: 1 }),
    );

    expect(result).toBe(false);
  });

  it("fails closed when array result allocation changes", () => {
    class AlternateArray extends Array<unknown> {
      override join(): string {
        return "attacker";
      }
    }

    const result = withOwnPropertyDescriptor(
      Array,
      Symbol.species,
      { get: () => AlternateArray },
      () => encodes([1, 2]),
    );

    expect(result).toBe(false);
  });
});

describe("canonical identity JSON bounds and domain decoding", () => {
  it.each([nestedArray(16), nestedObject(16), "0", '"scalar"'])(
    "accepts the bounded container depth in %s",
    (text) => {
      expect(parses(utf8(text))).toBe(true);
    },
  );

  it.each([nestedArray(17), nestedObject(17)])(
    "rejects excess container depth in %s",
    (text) => {
      expect(parses(utf8(text))).toBe(false);
    },
  );

  it("applies closed Schema decoding after canonical validation", () => {
    const closed = Schema.Struct({ a: Schema.Number });
    expect(succeeds(decodeCanonicalJson(closed, utf8('{"a":1,"b":2}')))).toBe(
      false,
    );
  });
});
