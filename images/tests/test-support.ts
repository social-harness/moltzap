/** @file JSON narrowing and loopback ports for agent-image tests. */
import { once } from "node:events";
import { createServer } from "node:net";
/** Reads a nested JSON member without asserting its type. */
export function member(value: unknown, ...path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current) || !Object.hasOwn(current, key)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

/**
 * Whether `value` is a plain JSON object, which excludes `null` and arrays.
 * @param value A decoded document or one of its members.
 * @returns The narrowing.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A loopback port nothing listened on when it was chosen; another process
 * may take it before the caller binds it.
 * @returns A TCP port number on 127.0.0.1.
 */
export async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  server.close();
  await once(server, "close");
  if (address === null || typeof address === "string") {
    throw new Error("a loopback TCP server has no port");
  }
  return address.port;
}

/** Narrows command records returned by stand-in host processes. */
export function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((part) => typeof part === "string")
  );
}
