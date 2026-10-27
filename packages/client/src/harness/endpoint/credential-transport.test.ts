/** @file Every credential-bearing Client consumer refuses unsafe URLs before any network request. */

import { Effect, Redacted } from "effect";
import { describe, expect, it, vi } from "vitest";
import { acquireHarnessEndpoint } from "./index.js";

const credential = Redacted.make(
  "fixture-runtime-grant-with-no-external-authority",
);

describe("runtime credential transport", () => {
  it.each([
    "http://remote.example/mcp",
    "http://localhost/mcp",
    "https://embedded:password@remote.example/mcp",
    "https://remote.example/mcp#credential",
    "ftp://remote.example/mcp",
  ])(
    "refuses %s without exposing a bearer on the network",
    refusesUnsafeTransport,
  );
  it(
    "keeps the validated address when the caller changes its URL before execution",
    keepsValidatedAddress,
  );
});

function refusesUnsafeTransport(url: string) {
  const fetch = vi.spyOn(globalThis, "fetch");
  return acquireHarnessEndpoint(new URL(url), { credential }).pipe(
    Effect.scoped,
    Effect.flip,
    Effect.tap((error) =>
      Effect.sync(() => {
        // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- Unsafe bearer transport uses the existing closed transport refusal rather than adding a public error variant.
        expect(error.reason).toBe("transport-failed");
        expect(fetch).not.toHaveBeenCalled();
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        fetch.mockRestore();
      }),
    ),
    Effect.asVoid,
    Effect.runPromise,
  );
}

function keepsValidatedAddress() {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 401 }));
  const endpoint = new URL("https://native.example/mcp");
  const validated = endpoint.href;
  const connection = acquireHarnessEndpoint(endpoint, { credential });
  endpoint.protocol = "http:";
  endpoint.hostname = "different.example";
  return connection.pipe(
    Effect.scoped,
    Effect.flip,
    Effect.tap(() =>
      Effect.sync(() => {
        expect(fetch).toHaveBeenCalled();
        const requested = fetch.mock.calls[0]?.[0];
        expect(requestedAddress(requested)).toBe(validated);
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        fetch.mockRestore();
      }),
    ),
    Effect.asVoid,
    Effect.runPromise,
  );
}

function requestedAddress(input?: Parameters<typeof globalThis.fetch>[0]) {
  return input instanceof Request ? input.url : input?.toString();
}
