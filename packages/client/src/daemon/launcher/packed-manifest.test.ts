/** @file Reading the manifest a package tarball carries from its bytes. */

import { HttpClient, HttpClientResponse } from "@effect/platform";
import { effect as it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, vi } from "vitest";
import { integrityOf } from "./integrity.js";
import { readPackedManifest } from "./packed-manifest.js";
import { verifyProvenance } from "./provenance.js";

/** A gzipped ustar archive holding `files`, as `npm pack` lays one out. */
const tarball = (files: Readonly<Record<string, string>>): Uint8Array => {
  const blocks: Uint8Array[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = new TextEncoder().encode(text);
    const header = new Uint8Array(512);
    header.set(new TextEncoder().encode(name), 0);
    header.set(
      new TextEncoder().encode(body.length.toString(8).padStart(11, "0")),
      124,
    );
    header[156] = 0x30;
    blocks.push(
      header,
      body,
      new Uint8Array((512 - (body.length % 512)) % 512),
    );
  }
  blocks.push(new Uint8Array(1024));
  return gzipSync(Buffer.concat(blocks));
};

const manifest = {
  name: "@moltzap/social-harness",
  version: "2026.1025.1",
  dependencies: { "@moltzap/social-harness": "2026.1025.1" },
};

// @agent-code-guard/regression-only: The tarball layout is npm's, pinned by its examples.
describe("a packed manifest", () => {
  it("is read from package/package.json, past the other entries", () =>
    Effect.gen(function* () {
      const read = yield* readPackedManifest(
        tarball({
          "package/README.md": "x".repeat(700),
          "package/package.json": JSON.stringify(manifest),
        }),
      );
      expect(read).toMatchObject(manifest);
    }));

  it("is missing from a tarball without one, or from bytes that are not a tarball", () =>
    Effect.gen(function* () {
      for (const bytes of [
        tarball({ "package/index.js": "" }),
        new TextEncoder().encode("not gzip"),
      ]) {
        const exit = yield* Effect.exit(readPackedManifest(bytes));
        expect(Exit.isFailure(exit)).toBe(true);
      }
    }));
});

/** Sigstore cryptography is independent of the signed manifest field binding exercised here. */
vi.mock("sigstore", () => ({ verify: () => Promise.resolve() }));

/** A signed subject binds the fixture bundle to the exact package bytes. */
const attestationResponse = (
  name: string,
  version: string,
  bytes: Uint8Array,
) => {
  const subject = {
    name: `pkg:npm/%40moltzap/${name.slice("@moltzap/".length)}@${version}`,
    digest: { sha512: createHash("sha512").update(bytes).digest("hex") },
  };
  const payload = Buffer.from(JSON.stringify({ subject: [subject] })).toString(
    "base64",
  );
  return Response.json({
    attestations: [
      {
        predicateType: "https://slsa.dev/provenance/v1",
        bundle: {
          mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
          verificationMaterial: {
            certificate: { rawBytes: "AQ==" },
            tlogEntries: [],
          },
          dsseEnvelope: {
            payloadType: "application/vnd.in-toto+json",
            payload,
            signatures: [{ sig: "AQ==", keyid: "fixture" }],
          },
        },
      },
    ],
  });
};

it.each([
  { name: "@moltzap/identity", packedWire: "2026.1019.2", accepted: true },
  { name: "@moltzap/identity", packedWire: "2026.1019.1", accepted: false },
  {
    name: "@moltzap/social-harness",
    packedWire: "2026.1019.2",
    accepted: false,
  },
])(
  "binds legacy wire metadata only for the signed Identity manifest: $name $packedWire",
  ({ name, packedWire, accepted }) =>
    Effect.gen(function* () {
      const version = "2026.1025.1";
      const bytes = tarball({
        "package/package.json": JSON.stringify({
          name,
          version,
          moltzapWireVersion: packedWire,
        }),
      });
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            attestationResponse(name, version, bytes),
          ),
        ),
      );
      const exit = yield* verifyProvenance(
        {
          name,
          version,
          siblings: {},
          wireVersion: "2026.1019.2",
          integrity: integrityOf(bytes),
          tarball: "https://registry.test/package.tgz",
          attestations: "https://registry.test/attestations",
        },
        bytes,
        { tufCachePath: "/unused" },
      ).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(accepted);
    }),
);
