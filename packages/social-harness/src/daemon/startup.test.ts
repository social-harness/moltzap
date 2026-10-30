/** @file Startup failures expose safe diagnostics through every error representation. */

import { scopedLive as it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { expect } from "vitest";
import { loadDaemonProcessConfiguration } from "./configuration.js";
import { Daemon } from "./index.js";

const registryOriginVariable = "SHARNESS_REGISTRY_ORIGIN";
const rejectedValue =
  "https://operator:private-password@registry.example/private";
const environment = ConfigProvider.fromMap(
  new Map([[registryOriginVariable, rejectedValue]]),
);

// @agent-code-guard/regression-only: Exact startup failures pin redaction and operator remedies at the public daemon boundary.
it("removes configured values from startup error serialization and causes", () =>
  Effect.gen(function* () {
    const error = yield* Layer.build(Daemon.layer).pipe(
      Effect.scoped,
      Effect.withConfigProvider(environment),
      Effect.flip,
    );
    expect(error).toBeInstanceOf(Daemon.StartupError);
    expect(error.message).toContain(registryOriginVariable);
    expect(JSON.stringify(error.toJSON())).not.toContain(rejectedValue);
    expect(String(error)).not.toContain(rejectedValue);
    expect(error.cause).toBeUndefined();
  }));

it("removes decoder failures from daemon configuration errors", () =>
  Effect.gen(function* () {
    const error = yield* loadDaemonProcessConfiguration.pipe(
      Effect.withConfigProvider(environment),
      Effect.flip,
    );
    expect(error.message).toContain(registryOriginVariable);
    expect(JSON.stringify(error.toJSON())).not.toContain(rejectedValue);
    expect(String(error)).not.toContain(rejectedValue);
    expect(error.cause).toBeUndefined();
  }));

it("names both the closed compatibility reason and safe operator detail", () =>
  Effect.sync(() => {
    const error = new Daemon.StartupError({
      phase: "storage",
      reason: "outbox-too-old",
      detail: "Drain the outbox with an earlier release before upgrading",
    });
    expect(error.message).toContain(error.phase);
    expect(error.message).toContain(error.reason);
    expect(error.message).toContain(error.detail);
    expect(error.cause).toBeUndefined();
  }));

it("explains the network reset and remedy when the agent is no longer admitted", () =>
  Effect.sync(() => {
    const error = new Daemon.StartupError({
      phase: "listener",
      reason: "agent-not-admitted",
    });
    expect(error.message).toContain(error.phase);
    expect(error.message).toContain(error.reason);
    expect(error.message).toMatch(
      /network was reset; reset the agent and register again/u,
    );
    expect(error.message).toMatch(
      /Docs: https:\/\/docs\.moltzap\.xyz\/guides\/run-sharnessd#reset-an-agent-after-the-network-restarts$/,
    );
  }));

it("names the refused admission credential and its remedy at startup", () =>
  Effect.sync(() => {
    const error = new Daemon.StartupError({
      phase: "registration",
      reason: "admission-refused",
    });
    expect(error.message).toContain(error.phase);
    expect(error.message).toContain(error.reason);
    expect(error.message).toMatch(
      /The Registry refused the admission credential/u,
    );
    expect(error.message).toMatch(
      /supply this network's admission credential/u,
    );
    expect(error.message).toMatch(
      /Docs: https:\/\/docs\.moltzap\.xyz\/guides\/run-sharnessd#the-registry-refused-the-admission-credential$/,
    );
  }));

it.each([
  "SHARNESS_EXPERIMENT_HIDE_GROUPS",
  "SHARNESS_EXPERIMENT_HIDE_COLLECTIVES",
] as const)("fails startup naming invalid experiment switch %s", (variable) =>
  Effect.gen(function* () {
    const provider = ConfigProvider.fromMap(
      new Map([
        ["SHARNESS_STATE_DIRECTORY", "/run/social-harness/unused-state"],
        ["SHARNESS_MCP_PORT", "4319"],
        [
          "SHARNESS_MCP_CREDENTIAL_FILE",
          "/run/social-harness/unused-mcp-credential",
        ],
        ["SHARNESS_REGISTRY_ORIGIN", "https://registry.example"],
        [
          "SHARNESS_REGISTRY_SIGNER_PUBLIC_KEY",
          '{"crv":"Ed25519","kty":"OKP","x":"y1j1FUgbqjCPeQVEnllv-2euwn_s9DeDkfEh3gk_OJ0"}',
        ],
        ["SHARNESS_ROUTER_ORIGIN", "https://router.example"],
        ["SHARNESS_AGENT_PRIVATE_KEY_FILE", "/run/social-harness/unused-key"],
        [variable, "sometimes"],
      ]),
    );
    const error = yield* Layer.build(Daemon.layer).pipe(
      Effect.scoped,
      Effect.withConfigProvider(provider),
      Effect.flip,
    );
    expect(error).toMatchObject({ phase: "configuration" });
    expect(error.message).toContain(`: ${variable} must satisfy`);
    expect(error.message).toMatch(
      /true, yes, on, 1, false, no, off or 0\. Docs: https:\/\/docs\.moltzap\.xyz\/guides\/run-sharnessd#setting$/u,
    );
  }),
);
