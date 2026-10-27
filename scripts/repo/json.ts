/** @file JSON readers for repository manifests. */
import { Data } from "effect";
import { readFileSync } from "node:fs";

/** Fields remain unknown until a consumer narrows them. */
export type JsonObject = Readonly<Record<string, unknown>>;

/** Malformed manifests cannot supply dependency-version evidence. */
export class MalformedJsonInput extends Data.TaggedError("MalformedJsonInput")<{
  readonly message: string;
}> {}

/**
 * Read and decode a JSON file whose top level must be an object.
 * @param file Absolute path.
 * @returns The decoded object; malformed input fails the check.
 */
export function readJsonObject(file: string): JsonObject {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isJsonObject(value)) {
    throw new MalformedJsonInput({
      message: `Malformed ${file}: expected a JSON object`,
    });
  }
  return value;
}

/**
 * Optional object fields default to empty; malformed fields fail decoding.
 * @param source Object holding the field.
 * @param key Field name.
 * @returns The nested object.
 */
export function objectAt(source: JsonObject, key: string): JsonObject {
  const value = source[key];
  if (value === undefined) {
    return {};
  }
  if (!isJsonObject(value)) {
    throw new MalformedJsonInput({
      message: `Malformed ${key}: expected an object`,
    });
  }
  return value;
}

/**
 * The string at one field.
 * @param source Object holding the field.
 * @param key Field name.
 * @returns The string, or undefined when absent or not a string.
 */
export function stringAt(source: JsonObject, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Whether a decoded JSON value is an object rather than an array or primitive.
 * @param value Decoded value.
 * @returns True for a plain JSON object.
 */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
