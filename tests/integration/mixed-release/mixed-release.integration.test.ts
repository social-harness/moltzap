/**
 * @file Published peers and the current daemon certify posts in both
 * directions, through the current network and through the previous release's
 * network.
 *
 */

import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { acquireHarnessEndpoint, AgentAddress } from "@moltzap/client";
import {
  HISTORY_WIRE_VERSIONS,
  LIVE_WIRE_VERSIONS,
  WIRE_VERSION,
} from "@moltzap/identity";
import { Data, Effect, Fiber, Option, Schedule, Schema, Stream } from "effect";
import { join, resolve } from "node:path";
import { expect, it, type TestContext } from "vitest";
import {
  installPackedConsumer,
  packWorkspaceClosure,
  runCommand,
} from "../../../scripts/test/packed-workspace.js";
import {
  acquireDaemonManagementClient,
  acquireDaemonProcess,
  acquireProcessInfrastructure,
  acquireProcessInfrastructureFrom,
  type DaemonProcessFixture,
  makeDaemonProcessFixture,
  makeRegistrationRequest,
  ProcessTestError,
} from "../daemon-process-harness.js";

// @agent-code-guard/regression-only: Regression cases exercise the reviewed release selection, reset boundary, missing metadata, and registry outage failures; the real process exchange checks interoperability.

const RESET_SKIP_REASON =
  "No post-reset release is published; the mixed-release gate starts with the first release after the reset.";
const workspaceRoot = resolve(import.meta.dirname, "../../..");
const packages = {
  "@moltzap/identity": join(workspaceRoot, "packages/identity"),
  "@moltzap/router": join(workspaceRoot, "packages/router"),
  "@moltzap/client": join(workspaceRoot, "packages/client"),
};

/**
 * The first package release after the last protocol reset. A reset change
 * moves it above the release it drops, so the gate skips that release rather
 * than failing on it.
 */
const FIRST_POST_RESET_RELEASE = Option.some("2026.1021.3");
const PRE_RESET_WIRE_VERSION = "pre-reset";

function preResetRelease(
  version: string,
  firstPostResetRelease?: string,
): boolean {
  if (firstPostResetRelease === undefined) {
    return true;
  }
  const parts = version.split(".").map(Number);
  const boundary = firstPostResetRelease.split(".").map(Number);
  for (const [index, part] of parts.entries()) {
    const minimum = boundary[index];
    if (minimum !== undefined && part !== minimum) {
      return part < minimum;
    }
  }
  return false;
}

/** Only registry availability failures can waive this network-dependent gate. */
function npmOutage(error: unknown): boolean {
  return (
    error instanceof Error &&
    /EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|E(?:408|429|500|502|503|504)|ERR_PNPM_FETCH_(?:408|429|500|502|503|504)|FETCH_ERROR|fetch failed/iu.test(
      error.message,
    )
  );
}

/** Wire metadata is read without downloading or installing release closures. */
function releaseWireVersion(
  version: string,
  view = npmView,
  firstPostResetRelease = FIRST_POST_RESET_RELEASE,
) {
  return releaseClosure(version, view).pipe(
    Effect.map((closure) => closure["@moltzap/identity"]),
    Effect.flatMap((identity) =>
      view([`@moltzap/identity@${identity}`]).pipe(
        Effect.flatMap(
          Schema.decodeUnknown(
            Schema.parseJson(
              Schema.Struct({
                sharnessWireVersion: Schema.optional(Schema.String),
              }),
            ),
          ),
        ),
        Effect.map(({ sharnessWireVersion }) => ({
          identity,
          sharnessWireVersion,
        })),
      ),
    ),
    Effect.flatMap(({ identity, sharnessWireVersion }) => {
      if (sharnessWireVersion !== undefined) {
        return Effect.succeed(sharnessWireVersion);
      }
      return preResetRelease(
        version,
        Option.getOrUndefined(firstPostResetRelease),
      )
        ? Effect.succeed(PRE_RESET_WIRE_VERSION)
        : Effect.fail(
            new ProcessTestError({
              message: `@moltzap/identity@${identity}, pinned by @moltzap/client@${version}, is missing published sharnessWireVersion metadata`,
            }),
          );
    }),
  );
}

/**
 * The exact Identity and Router versions a published Client release pins.
 * Packages publish at their own versions, so a Client release names its
 * closure; a pin it lacks is a malformed release.
 */
function releaseClosure(version: string, view = npmView) {
  return view([`@moltzap/client@${version}`, "dependencies"]).pipe(
    Effect.flatMap(
      Schema.decodeUnknown(
        Schema.parseJson(
          Schema.Struct({
            "@moltzap/identity": Schema.String,
            "@moltzap/router": Schema.String,
          }),
        ),
      ),
    ),
    Effect.map((pins) => ({ ...pins, "@moltzap/client": version })),
  );
}

function exchange(from: DaemonProcessFixture, to: DaemonProcessFixture) {
  return Effect.scoped(
    Effect.gen(function* () {
      const sender = yield* acquireHarnessEndpoint(from.endpoint);
      const receiver = yield* acquireHarnessEndpoint(to.endpoint);
      const waiting = yield* Stream.runHead(receiver.messages).pipe(
        Effect.forkScoped,
      );
      const text = `certified from ${from.agentName} to ${to.agentName}`;
      yield* sender.send({
        to: Schema.decodeUnknownSync(AgentAddress)(`agent:${to.agentName}`),
        text,
      });
      const received = yield* Fiber.join(waiting).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new ProcessTestError({
                  message: "peer ended before certified delivery",
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
      expect(received.item).toMatchObject({
        kind: "multicast",
        message: { content: [{ type: "text", text }] },
      });
      yield* received.acknowledge;
    }),
  );
}

/** Calendar releases use npm's semver ordering. */
function publishedVersions() {
  return npmView(["@moltzap/client", "versions"]).pipe(
    Effect.flatMap(
      Schema.decodeUnknown(Schema.parseJson(Schema.Array(Schema.String))),
    ),
    Effect.map((versions) =>
      versions.filter((version) => /^\d{4}\.\d{3,4}\.\d+$/u.test(version)),
    ),
  );
}

/** An npm operation exhausted its transport retries, rather than returning invalid metadata. */
class NpmOutageError extends Data.TaggedError("NpmOutageError")<{
  readonly message: string;
}> {}

function npmUnavailable(error: unknown) {
  return Effect.fail(new NpmOutageError({ message: String(error) }));
}

function npmView(args: readonly string[]) {
  return runCommand("npm", [
    "view",
    ...args,
    "--json",
    "--fetch-retries=0",
    "--fetch-timeout=15000",
  ]).pipe(retryNpm);
}

function retryNpm<A, E, R>(operation: Effect.Effect<A, E, R>) {
  return operation.pipe(
    Effect.retry({
      schedule: Schedule.exponential("1 second").pipe(
        Schedule.intersect(Schedule.recurs(2)),
      ),
      while: npmOutage,
    }),
    Effect.catchIf(npmOutage, npmUnavailable),
  );
}

function installCandidate(temporaryRoot: string, version: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({
      directory: temporaryRoot,
      prefix: `peer-${version}-`,
    });
    return yield* installPackedConsumer({
      temporaryRoot: root,
      workspaceRoot,
      name: "mixed-release-peer",
      archives: {},
      dependencies: yield* releaseClosure(version),
    });
  }).pipe(retryNpm);
}

/**
 * Stop at the explicit reset boundary, retaining the oldest live release. A
 * previous release outside retained history skips the gate only when the
 * reset boundary places it before the reset; otherwise the current build
 * dropped a version it still owes the previous release, and the gate fails.
 */
function selectReleases(
  versions: readonly string[],
  readVersion = releaseWireVersion,
  sets: {
    readonly live: readonly string[];
    readonly history: readonly string[];
  } = {
    live: LIVE_WIRE_VERSIONS,
    history: HISTORY_WIRE_VERSIONS,
  },
  firstPostResetRelease = FIRST_POST_RESET_RELEASE,
) {
  return Effect.gen(function* () {
    const previous = versions.at(-1);
    if (previous === undefined) {
      return yield* new ProcessTestError({
        message: "npm returned no calendar releases",
      });
    }
    const previousWireVersion = yield* readVersion(previous);
    if (!sets.history.includes(previousWireVersion)) {
      const boundary = Option.getOrUndefined(firstPostResetRelease);
      if (boundary !== undefined && preResetRelease(previous, boundary)) {
        return [];
      }
      return yield* new ProcessTestError({
        message: `release ${previous} emits wire version ${previousWireVersion}, which this build neither admits nor retains; only a reset that moves FIRST_POST_RESET_RELEASE above ${previous} may drop it`,
      });
    }
    expect(sets.live).toContain(previousWireVersion);
    const oldest = yield* oldestLiveRelease(versions, readVersion, sets);
    return [...new Set([previous, oldest ?? previous])];
  });
}

/** The oldest release before the reset boundary whose wire version is live. */
function oldestLiveRelease<E, R>(
  versions: readonly string[],
  readVersion: (version: string) => Effect.Effect<string, E, R>,
  sets: {
    readonly live: readonly string[];
    readonly history: readonly string[];
  },
) {
  return Effect.gen(function* () {
    let oldest: string | undefined;
    for (const version of [...versions].reverse().slice(1)) {
      const wireVersion = yield* readVersion(version);
      if (!sets.history.includes(wireVersion)) {
        break;
      }
      if (sets.live.includes(wireVersion)) {
        oldest = version;
      }
    }
    return oldest;
  });
}

/**
 * Names the gate leg a failure came from: a fixture failure carries the leg in
 * its message, and every failure logs it.
 */
function inLeg(leg: string) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchIf(
        (error): error is E & ProcessTestError =>
          error instanceof ProcessTestError,
        (error) =>
          Effect.fail(
            new ProcessTestError({
              message: `${leg}: ${error.message}`,
              cause: error,
            }),
          ),
      ),
      Effect.tapError(() =>
        Effect.logError(`mixed-release leg failed: ${leg}`),
      ),
    );
}

/**
 * The previous release's Registry and Router, which a daemon that upgrades
 * before its network must still reach.
 */
function releaseNetwork(consumer: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const published = join(consumer, "node_modules/.bin/sharness-registry");
    if (!(yield* fs.exists(published))) {
      return yield* new ProcessTestError({
        message:
          "Previous-release Registry bin is unavailable; the previous Registry comes from that release's image once images exist. Docs: https://github.com/social-harness/moltzap/blob/main/docs/spec/layer-interfaces.md#publication-and-versions",
      });
    }
    return {
      registry: published,
      router: join(consumer, "node_modules/.bin/sharness-router"),
    };
  });
}

function installCurrent(temporaryRoot: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({
      directory: temporaryRoot,
      prefix: "current-",
    });
    const { archives } = yield* packWorkspaceClosure(
      packages,
      root,
      new Set(Object.keys(packages)),
    );
    const currentRoot = join(root, "current");
    yield* fs.makeDirectory(currentRoot);
    return yield* installPackedConsumer({
      temporaryRoot: currentRoot,
      workspaceRoot,
      name: "mixed-release-current",
      archives,
    });
  }).pipe(retryNpm);
}

/** One published daemon and one current daemon certify through `infrastructure`. */
function certifyPair(
  infrastructure: Effect.Effect.Success<typeof acquireProcessInfrastructure>,
  version: string,
  consumer: string,
  current: string,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* makeDaemonProcessFixture(
        infrastructure,
        `peer-${version.replaceAll(".", "-")}`,
      );
      const local = yield* makeDaemonProcessFixture(
        infrastructure,
        `local-${version.replaceAll(".", "-")}`,
      );
      yield* acquireDaemonProcess(
        peer,
        join(consumer, "node_modules/.bin/sharnessd"),
      );
      yield* acquireDaemonProcess(
        local,
        join(current, "node_modules/.bin/sharnessd"),
      );
      for (const fixture of [peer, local]) {
        const management = yield* acquireDaemonManagementClient(
          fixture.endpoint,
        );
        const registration = yield* management.register(
          makeRegistrationRequest(fixture),
        );
        if (registration.kind !== "registered") {
          return yield* new ProcessTestError({
            message: `registration failed for ${fixture.agentName}`,
          });
        }
      }
      yield* exchange(local, peer);
      yield* exchange(peer, local);
    }),
  );
}

const mixedRelease = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const temporaryRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "mixed-release-",
    });
    const versions = yield* publishedVersions();
    const releases = yield* selectReleases(versions);
    if (releases.length === 0) {
      return RESET_SKIP_REASON;
    }
    const current = yield* installCurrent(temporaryRoot);
    const currentNetwork = yield* acquireProcessInfrastructure;
    for (const version of releases) {
      const consumer = yield* installCandidate(temporaryRoot, version);
      yield* certifyPair(currentNetwork, version, consumer, current).pipe(
        inLeg(`release ${version} daemon through the current network`),
      );
      if (version === releases[0]) {
        yield* Effect.scoped(
          acquireProcessInfrastructureFrom(
            yield* releaseNetwork(consumer),
          ).pipe(
            Effect.flatMap((previousNetwork) =>
              certifyPair(previousNetwork, version, consumer, current),
            ),
          ),
        ).pipe(
          inLeg(
            `current daemon through the network of previous release ${version}`,
          ),
        );
      }
    }
    return undefined;
  }),
).pipe(
  Effect.catchTag("NpmOutageError", (error) =>
    Effect.succeed(
      `npm outage after retries; mixed-release gate skipped: ${String(error)}`,
    ),
  ),
  Effect.provide(NodeContext.layer),
);

function runMixedRelease(context: TestContext) {
  const fiber = Effect.runFork(mixedRelease);
  context.onTestFinished(
    () => Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.asVoid)),
    60_000,
  );
  return Effect.runPromise(
    Fiber.join(fiber).pipe(
      Effect.tap((reason) =>
        reason === undefined
          ? Effect.void
          : Effect.logWarning(reason).pipe(
              Effect.zipRight(Effect.sync(() => context.skip(reason))),
            ),
      ),
      Effect.asVoid,
    ),
  );
}

it(
  "certifies with the previous and oldest in-window published releases and through the previous network",
  runMixedRelease,
  600_000,
);

/** The older Identity version every fake Client release pins. */
const PINNED_IDENTITY = "2099.1.0";
const PINNED_WIRE_VERSION = "2099.1.1";

/**
 * An npm view whose Client releases pin Identity and Router at their own,
 * older versions, and whose Identity versions all report `identity`.
 */
function publishedMetadata(identity: string) {
  return (args: readonly string[]) =>
    Effect.succeed(
      args[0]?.startsWith("@moltzap/client@") === true
        ? JSON.stringify({
            "@moltzap/identity": PINNED_IDENTITY,
            "@moltzap/router": "2099.2.0",
          })
        : identity,
    );
}

it("reads a Client release's wire version from the Identity version it pins", () =>
  Effect.runPromise(
    releaseWireVersion(
      "2099.101.0",
      (args) =>
        Effect.succeed(
          JSON.stringify(
            args[0] === "@moltzap/client@2099.101.0"
              ? {
                  "@moltzap/identity": PINNED_IDENTITY,
                  "@moltzap/router": "2099.2.0",
                }
              : {
                  sharnessWireVersion:
                    args[0] === `@moltzap/identity@${PINNED_IDENTITY}`
                      ? PINNED_WIRE_VERSION
                      : WIRE_VERSION,
                },
          ),
        ),
      Option.some("2099.101.0"),
    ).pipe(
      Effect.tap((wireVersion) =>
        Effect.sync(() => {
          expect(wireVersion).toBe(PINNED_WIRE_VERSION);
        }),
      ),
      Effect.provide(NodeContext.layer),
    ),
  ));

it("selects the oldest live peer rather than an older retained peer", () =>
  Effect.runPromise(
    selectReleases(
      ["2099.101.0", "2099.102.0", "2099.103.0", "2099.104.0"],
      (version) =>
        Effect.succeed(
          new Map([
            ["2099.104.0", "new"],
            ["2099.101.0", "retired"],
          ]).get(version) ?? "old",
        ),
      { live: ["old", "new"], history: ["retired", "old", "new"] },
    ).pipe(
      Effect.provide(NodeContext.layer),
      Effect.tap((releases) =>
        Effect.sync(() => {
          expect(releases).toEqual(["2099.104.0", "2099.102.0"]);
        }),
      ),
    ),
  ));

it("runs a single peer when the previous release is also the oldest live release", () =>
  Effect.runPromise(
    selectReleases(
      ["2099.101.0", "2099.102.0"],
      (version) =>
        Effect.succeed(version === "2099.101.0" ? "pre-reset" : "new"),
      { live: ["new"], history: ["new"] },
    ).pipe(
      Effect.provide(NodeContext.layer),
      Effect.tap((releases) =>
        Effect.sync(() => {
          expect(releases).toEqual(["2099.102.0"]);
        }),
      ),
    ),
  ));

it("skips when the reset boundary places the previous release before the reset", () =>
  Effect.runPromise(
    selectReleases(
      ["2099.101.0"],
      () => Effect.succeed(PRE_RESET_WIRE_VERSION),
      {
        live: ["new"],
        history: ["new"],
      },
      Option.some("2099.102.0"),
    ).pipe(
      Effect.provide(NodeContext.layer),
      Effect.tap((releases) =>
        Effect.sync(() => {
          expect(releases).toEqual([]);
        }),
      ),
    ),
  ));

it.each([Option.none<string>(), Option.some("2099.101.0")])(
  "fails when the previous release's version left history without a reset boundary above it (%o)",
  (boundary) =>
    Effect.runPromise(
      selectReleases(
        ["2099.101.0"],
        () => Effect.succeed("old"),
        { live: ["new"], history: ["new"] },
        boundary,
      ).pipe(
        Effect.flip,
        Effect.tap((error) =>
          Effect.sync(() => {
            expect(error).toBeInstanceOf(ProcessTestError);
          }),
        ),
        Effect.provide(NodeContext.layer),
        Effect.asVoid,
      ),
    ),
);

it.each(["2099.101.0", "2099.102.0"])(
  "fails when post-reset release %s omits wire metadata",
  (version) =>
    Effect.runPromise(
      releaseWireVersion(
        version,
        publishedMetadata("{}"),
        Option.some("2099.101.0"),
      ).pipe(
        Effect.flip,
        Effect.tap((error) =>
          Effect.sync(() => {
            expect(error).toMatchObject({
              _tag: "ProcessTestError",
              message: `@moltzap/identity@${PINNED_IDENTITY}, pinned by @moltzap/client@${version}, is missing published sharnessWireVersion metadata`,
            });
          }),
        ),
        Effect.provide(NodeContext.layer),
        Effect.asVoid,
      ),
    ),
);

it.each([
  ["2026.1019.1", Option.none<string>()],
  ["2099.101.0", Option.none<string>()],
  ["2099.100.0", Option.some("2099.101.0")],
])(
  "treats metadata-free %s as pre-reset before boundary %s",
  (version, boundary) =>
    Effect.runPromise(
      releaseWireVersion(version, publishedMetadata("{}"), boundary).pipe(
        Effect.tap((wireVersion) =>
          Effect.sync(() => {
            expect(wireVersion).toBe(PRE_RESET_WIRE_VERSION);
          }),
        ),
        Effect.provide(NodeContext.layer),
        Effect.asVoid,
      ),
    ),
);

it("reads published wire metadata at the reset boundary", () =>
  Effect.runPromise(
    releaseWireVersion(
      "2099.101.0",
      publishedMetadata(JSON.stringify({ sharnessWireVersion: WIRE_VERSION })),
      Option.some("2099.101.0"),
    ).pipe(
      Effect.tap((wireVersion) =>
        Effect.sync(() => {
          expect(wireVersion).toBe(WIRE_VERSION);
        }),
      ),
      Effect.provide(NodeContext.layer),
    ),
  ));

it.each([
  ["npm error code E503", true],
  ["npm error code EAI_AGAIN", true],
  ["ERR_PNPM_FETCH_503 Service Unavailable - 503", true],
  ["ERR_PNPM_FETCH_429 Too Many Requests - 429", true],
  ["ERR_PNPM_FETCH_404 Not Found - 404", false],
  ["npm error code E404", false],
  ["invalid release metadata", false],
])("classifies registry availability: %s", (message, outage) => {
  expect(npmOutage(new Error(message))).toBe(outage);
});
