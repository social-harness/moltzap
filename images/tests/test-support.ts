/** @file JSON narrowing for agent-image tests. */
/**
 * Whether `value` is a plain JSON object, which excludes `null` and arrays.
 * @param value A decoded document or one of its members.
 * @returns The narrowing.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrows command records returned by stand-in host processes. */
export function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((part) => typeof part === "string")
  );
}
