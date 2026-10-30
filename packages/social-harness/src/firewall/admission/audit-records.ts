/** @file Defines policy installations and check records used by the firewall and its audit. */

import { Effect, Schema, Struct } from "effect";
import type { FirewallAuditEntry } from "../store/index.js";
import { decodeRuntimeValue } from "../../communication/store/index.js";
import { exactStruct } from "../../encoding/exact.js";
import { AgentView } from "../../identity/cards.js";
import {
  type FirewallCheck,
  firewallCheckSchema,
  Message,
  MessageContext,
} from "../evaluator/index.js";
import { firewallInstallationSchema } from "../policy/contract.js";

// safer-arch-ignore file-implicit-boundary-module: Checking and audit projection share exact retained value schemas; only admission/index.ts exposes these private implementations to service composition.

/** A missing projected message records an unsupported candidate without inventing attribution. */
const firewallAuditInput = exactStruct({
  configurationDigest: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/u)),
  installation: firewallInstallationSchema,
  context: MessageContext,
  agents: Schema.Array(AgentView),
  message: Schema.NullOr(Message),
});

/**
 * A check as the store retains it: every field except the decision-provider
 * traces, which stay in memory with the code that produced the check.
 */
export const withoutTraces = (check: FirewallCheck) => ({
  ...check,
  checks: check.checks.map((middleware) => Struct.omit(middleware, "trace")),
});

/**
 * Opaque retained bytes are interpreted only by their Client delivery owner.
 * A retained result that holds provider traces decodes without them.
 */
export const decodeFirewallAuditEntry = Effect.fn("decodeFirewallAuditEntry")(
  function* (entry: FirewallAuditEntry) {
    const input = yield* decodeRuntimeValue(
      firewallAuditInput,
      entry.canonicalInput,
    );
    const result =
      entry.canonicalResult === undefined
        ? null
        : withoutTraces(
            yield* decodeRuntimeValue(
              firewallCheckSchema,
              entry.canonicalResult,
            ),
          );
    return {
      checkId: entry.checkId,
      direction: entry.direction,
      disposition: entry.disposition,
      candidate: entry.canonicalCandidate,
      input,
      result,
    };
  },
);
