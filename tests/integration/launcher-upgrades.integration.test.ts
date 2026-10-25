/** @file Real packed library releases upgrade twice through one persistent launcher record. */
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import {
  extractPackedArchive,
  installPackedConsumer,
  PackGateError,
  packProductClosure,
  runCommand,
} from "../../scripts/test/packed-workspace.js";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const prepared = Schema.parseJson(
  Schema.Struct({
    version: Schema.String,
    prefix: Schema.String,
    previous: Schema.optional(Schema.String),
    daemon: Schema.String,
  }),
);
const manifestSchema = Schema.parseJson(
  Schema.Struct({
    name: Schema.String,
    version: Schema.String,
    dependencies: Schema.Record({ key: Schema.String, value: Schema.String }),
    sharnessWireVersion: Schema.String,
    sharnessContentHash: Schema.optional(Schema.String),
  }),
);

type Reply = Readonly<{ bytes: Uint8Array; contentType: string }>;

/** Local metadata and tarball serving keeps release installation on the ordinary HTTP path. */
const registry = (replies: ReadonlyMap<string, Reply>) =>
  Effect.acquireRelease(
    Effect.async<{ server: Server; origin: string }, PackGateError>(
      (resume) => {
        const server = createServer((request, response) => {
          const reply = replies.get(request.url ?? "");
          if (reply === undefined) {
            response.writeHead(307, {
              location: `https://registry.npmjs.org${request.url ?? "/"}`,
            });
            response.end();
            return;
          }
          response.writeHead(200, {
            "content-type": reply?.contentType ?? "text/plain",
          });
          response.end(reply?.bytes);
        });
        server.once("error", (cause) =>
          resume(Effect.fail(new PackGateError({ message: cause.message }))),
        );
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (address === null || typeof address === "string") {
            server.close();
            resume(
              Effect.fail(
                new PackGateError({
                  message: "Registry fixture has no TCP address",
                }),
              ),
            );
          } else {
            resume(
              Effect.succeed({
                server,
                origin: `http://127.0.0.1:${address.port}`,
              }),
            );
          }
        });
      },
    ),
    ({ server }) =>
      Effect.promise(
        () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      ),
  );

const json = (value: unknown): Reply => ({
  bytes: new TextEncoder().encode(JSON.stringify(value)),
  contentType: "application/json",
});

/** The verifier stand-in leaves the real bundle parser, subject binding and packed manifest checks active. */
function attestation(version: string, digest: string): Reply {
  return json({
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
            payload: Buffer.from(
              JSON.stringify({
                subject: [
                  {
                    name: `pkg:npm/%40moltzap/client@${version}`,
                    digest: { sha512: digest },
                  },
                ],
              }),
            ).toString("base64"),
            signatures: [{ sig: "AQ==", keyid: "fixture" }],
          },
        },
      },
    ],
  });
}

it(
  "performs two consecutive launcher upgrades between real packed installations",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const scratch = yield* fs.makeTempDirectoryScoped({
            prefix: "launcher-upgrades-",
          });
          const { archives } = yield* packProductClosure(
            workspaceRoot,
            "client",
            scratch,
          );
          const archive = archives["@moltzap/client"];
          if (archive === undefined)
            return yield* new PackGateError({
              message: "Client tarball is missing",
            });
          const source = yield* extractPackedArchive(archive, scratch);
          const manifestFile = join(source, "package.json");
          const text = yield* fs.readFileString(manifestFile);
          const original = yield* Schema.decodeUnknown(
            Schema.parseJson(
              Schema.Record({ key: Schema.String, value: Schema.Unknown }),
            ),
          )(text);
          const replies = new Map<string, Reply>();
          const { origin } = yield* registry(replies);
          const versions = ["2099.101.0", "2099.101.1", "2099.101.2"];
          const packed = new Map<string, string>();
          for (const version of versions) {
            const manifest = { ...original, version };
            yield* fs.writeFileString(manifestFile, JSON.stringify(manifest));
            yield* runCommand(
              "npm",
              ["pack", "--ignore-scripts", "--pack-destination", scratch],
              { cwd: source },
            );
            const tarball = join(scratch, `moltzap-client-${version}.tgz`);
            packed.set(version, tarball);
            const bytes = yield* fs.readFile(tarball);
            const digest = createHash("sha512").update(bytes).digest();
            const admitted = yield* Schema.decodeUnknown(manifestSchema)(
              JSON.stringify(manifest),
            );
            replies.set(
              `/@moltzap%2fclient/${version}`,
              json({
                ...admitted,
                dist: {
                  integrity: `sha512-${digest.toString("base64")}`,
                  tarball: `${origin}/tarballs/${version}`,
                  attestations: { url: `${origin}/attestations/${version}` },
                },
              }),
            );
            replies.set(`/tarballs/${version}`, {
              bytes,
              contentType: "application/octet-stream",
            });
            replies.set(
              `/attestations/${version}`,
              attestation(version, digest.toString("hex")),
            );
          }
          const first = versions[0];
          const firstArchive =
            first === undefined ? undefined : packed.get(first);
          if (first === undefined || firstArchive === undefined)
            return yield* new PackGateError({
              message: "Seed release did not pack",
            });
          const seed = yield* installPackedConsumer({
            temporaryRoot: scratch,
            workspaceRoot,
            name: "launcher-upgrade-consumer",
            archives: { "@moltzap/client": firstArchive },
          });
          const home = join(scratch, "home");
          let prefix = seed;
          let previous = first;
          for (const version of versions.slice(1)) {
            const output = yield* runCommand(
              process.execPath,
              [
                "--import",
                join(import.meta.dirname, "launcher-provenance.ts"),
                join(
                  prefix,
                  "node_modules/@moltzap/client/bin/sharnessd-launcher",
                ),
                "prepare",
              ],
              {
                cwd: prefix,
                env: {
                  SHARNESS_LAUNCHER_DIRECTORY: home,
                  SHARNESS_LAUNCHER_SEED: seed,
                  SHARNESS_LAUNCHER_PACKAGE: "@moltzap/client",
                  SHARNESS_LAUNCHER_UPGRADE: "on",
                  SHARNESS_LAUNCHER_VERSION: version,
                  SHARNESS_LAUNCHER_REGISTRY: origin,
                },
              },
            );
            const choice = yield* Schema.decodeUnknown(prepared)(output.trim());
            expect(choice.version).toBe(version);
            expect(choice.previous).toBe(previous);
            expect(choice.prefix).not.toBe(prefix);
            expect(yield* fs.exists(choice.daemon)).toBe(true);
            const recorded = yield* fs
              .readFileString(join(home, "launcher.json"))
              .pipe(
                Effect.flatMap(
                  Schema.decodeUnknown(
                    Schema.parseJson(Schema.Struct({ version: Schema.String })),
                  ),
                ),
              );
            expect(recorded.version).toBe(version);
            prefix = choice.prefix;
            previous = version;
          }
        }),
      ).pipe(Effect.provide(NodeContext.layer)),
    ),
  600_000,
);
