/**
 * @file Accepts a downloaded package only when its bytes are the ones npm
 * recorded and a Sigstore-verified SLSA provenance attestation says this
 * project's release workflow on `main` built exactly those bytes.
 */

import type { HttpClient } from "@effect/platform";
import {
  bundleFromJSON,
  bundleToJSON,
  isBundleWithDsseEnvelope,
} from "@sigstore/bundle";
import { Effect, Schema } from "effect";
import { createHash } from "node:crypto";
import { verify } from "sigstore";
import { launcherError, type LauncherError } from "./errors.js";
import { integrityOf } from "./integrity.js";
import { downloadJson, type PublishedPackage } from "./npm.js";
import { type PackedManifest, readPackedManifest } from "./packed-manifest.js";

/**
 * The repositories whose release workflow the launcher trusts. The project
 * lives at `social-harness/moltzap`; `chughtapan/moltzap`, its earlier home,
 * stays trusted so releases built in either place verify for launchers
 * installed from either.
 */
const RELEASE_REPOSITORIES = [
  "social-harness/moltzap",
  "chughtapan/moltzap",
] as const;

/**
 * The build identities the launcher trusts: each certificate subject
 * alternative name for `.github/workflows/publish.yml` on `refs/heads/main`
 * of a {@link RELEASE_REPOSITORIES} repository.
 */
const RELEASE_IDENTITIES: readonly string[] = RELEASE_REPOSITORIES.map(
  (repository) =>
    `https://github.com/${repository}/.github/workflows/publish.yml@refs/heads/main`,
);

/** The OIDC issuer of GitHub Actions workload certificates. */
const RELEASE_ISSUER = "https://token.actions.githubusercontent.com";

const SLSA_PROVENANCE = "https://slsa.dev/provenance/v1";

const attestations = Schema.Struct({
  attestations: Schema.Array(
    Schema.Struct({ predicateType: Schema.String, bundle: Schema.Unknown }),
  ),
});

const statement = Schema.Struct({
  subject: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      digest: Schema.Struct({ sha512: Schema.String }),
    }),
  ),
});

/** Where Sigstore keeps its trust root between starts. */
interface ProvenanceOptions {
  readonly tufCachePath: string;
}

/**
 * Checks that `bytes` are the tarball npm recorded for `published` and that
 * its SLSA provenance, signed for one of {@link RELEASE_IDENTITIES}, covers them;
 * fails with `provenance` naming the package otherwise.
 */
export const verifyProvenance = Effect.fn("Launcher.verifyProvenance")(
  function* (
    published: PublishedPackage,
    bytes: Uint8Array,
    options: ProvenanceOptions,
  ) {
    const refuse = refusal(published);
    if (integrityOf(bytes) !== published.integrity) {
      return yield* refuse(
        "the tarball differs from the integrity npm recorded",
      );
    }
    if (published.attestations === undefined) {
      return yield* refuse("npm holds no attestations");
    }
    const payload = yield* signedPayload(
      published.attestations,
      options,
      refuse,
    );
    const subject = purl(published.name, published.version);
    const digest = createHash("sha512").update(bytes).digest("hex");
    const covered = payload.subject.some(
      (entry) => entry.name === subject && entry.digest.sha512 === digest,
    );
    if (!covered) {
      return yield* refuse(
        `its provenance does not cover ${subject} with these bytes`,
      );
    }
    const packed = yield* readPackedManifest(bytes).pipe(
      Effect.mapError((failure) => refuse(failure.message)),
    );
    const differing = differingField(published, packed);
    if (differing !== undefined) {
      return yield* refuse(
        `the registry's ${differing} differs from the signed package's`,
      );
    }
  },
);

/**
 * Succeeds when `verifyAs` accepts the bundle for any of
 * {@link RELEASE_IDENTITIES}; Sigstore matches one identity per call.
 */
export function signedByReleaseIdentity(
  verifyAs: (identity: string) => Effect.Effect<unknown, unknown>,
  refuse: (why: string) => LauncherError,
): Effect.Effect<void, LauncherError> {
  return Effect.firstSuccessOf(RELEASE_IDENTITIES.map(verifyAs)).pipe(
    Effect.asVoid,
    Effect.mapError(() =>
      refuse(
        `its provenance is not signed by ${RELEASE_IDENTITIES.join(" or ")}`,
      ),
    ),
  );
}

/**
 * The first field the registry reported for a package that its signed
 * manifest does not carry, so a registry cannot drop a sibling pin from the
 * verified closure or report another wire version or host-code hash.
 */
function differingField(
  published: PublishedPackage,
  packed: PackedManifest,
): string | undefined {
  const siblings = Object.entries(packed.dependencies ?? {}).filter(([name]) =>
    name.startsWith("@moltzap/"),
  );
  const checks: ReadonlyArray<readonly [string, boolean]> = [
    ["name", packed.name === published.name],
    ["version", packed.version === published.version],
    [
      "sibling pins",
      JSON.stringify(sorted(siblings)) ===
        JSON.stringify(sorted(Object.entries(published.siblings))),
    ],
    ["host-code hash", packed.sharnessHostCodeHash === published.hostCodeHash],
    [
      "wire version",
      (packed.sharnessWireVersion ??
        (packed.name === "@moltzap/identity"
          ? packed.moltzapWireVersion
          : undefined)) === published.wireVersion,
    ],
  ];
  return checks.find(([, same]) => !same)?.[0];
}

function sorted(
  entries: ReadonlyArray<readonly [string, string]>,
): ReadonlyArray<readonly [string, string]> {
  return [...entries].sort(([a], [b]) => a.localeCompare(b));
}

/** The provenance statement at `url`, once its signature verifies. */
function signedPayload(
  url: string,
  options: ProvenanceOptions,
  refuse: (why: string) => LauncherError,
): Effect.Effect<typeof statement.Type, LauncherError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const listed = yield* downloadJson(url).pipe(
      Effect.flatMap(Schema.decodeUnknown(attestations)),
      Effect.mapError(() => refuse("its attestations could not be read")),
    );
    const provenance = listed.attestations.find(
      (attestation) => attestation.predicateType === SLSA_PROVENANCE,
    );
    if (provenance === undefined) {
      return yield* refuse("npm holds no SLSA provenance");
    }
    const bundle = yield* Effect.try({
      try: () => bundleFromJSON(provenance.bundle),
      catch: () => refuse("its provenance bundle is malformed"),
    });
    if (!isBundleWithDsseEnvelope(bundle)) {
      return yield* refuse("its provenance carries no envelope");
    }
    yield* signedByReleaseIdentity(
      (identity) =>
        Effect.tryPromise(() =>
          verify(bundleToJSON(bundle), {
            certificateIssuer: RELEASE_ISSUER,
            certificateIdentityURI: identity,
            tufCachePath: options.tufCachePath,
          }),
        ),
      refuse,
    );
    return yield* Schema.decodeUnknown(Schema.parseJson(statement))(
      bundle.content.dsseEnvelope.payload.toString("utf8"),
    ).pipe(
      Effect.mapError(() => refuse("its provenance statement is malformed")),
    );
  });
}

function refusal(published: PublishedPackage): (why: string) => LauncherError {
  return (why) =>
    launcherError(
      "provenance",
      `${published.name}@${published.version}: ${why}`,
    );
}

function purl(name: string, version: string): string {
  return `pkg:npm/${name.replace("@", "%40")}@${version}`;
}
