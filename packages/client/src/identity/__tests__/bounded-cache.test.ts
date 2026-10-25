/** @file Bounded least-recently-used cache tests. */

import { Option } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { makeBoundedCache } from "../bounded-cache.js";

describe("makeBoundedCache eviction", () => {
  it("drops the least recently used entry once past its capacity", () => {
    const cache = makeBoundedCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);

    expect(cache.size()).toBe(2);
    expect(cache.get("a")).toStrictEqual(Option.none());
    expect(cache.get("b")).toStrictEqual(Option.some(2));
    expect(cache.get("c")).toStrictEqual(Option.some(3));
  });

  it("keeps an entry that was read while a newer entry arrives", () => {
    const cache = makeBoundedCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);

    expect(cache.get("a")).toStrictEqual(Option.some(1));
    expect(cache.get("b")).toStrictEqual(Option.none());
  });

  it("keeps an entry that was replaced while a newer entry arrives", () => {
    const cache = makeBoundedCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    // eslint-disable-next-line sonarjs/no-element-overwrite -- Replacing "a" must make it the most recently used entry.
    cache.set("a", 3);
    cache.set("c", 4);

    expect(cache.get("a")).toStrictEqual(Option.some(3));
    expect(cache.get("b")).toStrictEqual(Option.none());
  });

  it("never holds more entries than its capacity, whatever keys arrive", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }),
        fc.array(fc.integer({ min: 0, max: 20 }), { maxLength: 64 }),
        (capacity, keys) => {
          const cache = makeBoundedCache<number, number>(capacity);
          for (const key of keys) {
            cache.set(key, key);
          }

          expect(cache.size()).toBe(Math.min(capacity, new Set(keys).size));
        },
      ),
    );
  });
});

describe("makeBoundedCache values", () => {
  it("replaces a stored key's value without growing", () => {
    const cache = makeBoundedCache<string, number>(2);
    cache.set("a", 1);
    // eslint-disable-next-line sonarjs/no-element-overwrite -- The test stores a second value under the same key on purpose.
    cache.set("a", 2);

    expect(cache.size()).toBe(1);
    expect(cache.get("a")).toStrictEqual(Option.some(2));
  });

  it("holds an undefined value as present", () => {
    const cache = makeBoundedCache<string, undefined>(1);
    cache.set("a", undefined);

    expect(cache.get("a")).toStrictEqual(Option.some(undefined));
  });
});
