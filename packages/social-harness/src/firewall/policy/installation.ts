/** @file One captured policy installation and inference lifetime across editable activations. */

import { Effect } from "effect";
import { createHash } from "node:crypto";
import { encodeRuntimeValue } from "../../communication/store/index.js";
import {
  captureRegistration,
  CheckInputError,
  type DecisionProvider,
  decodeFrozen,
  type Firewall,
  FirewallSettings,
  makeCapturedFirewall,
  type MessageContext,
  type MessageMiddleware,
  type TextPolicySettings,
  type TextRule,
} from "../evaluator/index.js";
import {
  type FirewallConfiguration,
  firewallConfigurationSchema,
  type FirewallInstallation,
  type FirewallPolicyOperations,
} from "./contract.js";

/**
 * Code, facts and provider settings stay fixed for this process. Owner tools
 * edit only natural-language rules, and initial rules seed only a missing editable document.
 * @inline
 */
export interface FirewallOptions {
  readonly mode: "guidance" | "enforcement";
  readonly incoming: readonly MessageMiddleware[];
  readonly outgoing: readonly MessageMiddleware[];
  readonly settings: FirewallSettings;
  readonly facts: MessageContext["facts"];
  /** Operator-supplied SHA-256 identifier for the code, recorded without attestation. */
  readonly codeDigest: string;
  /** Recent certified records per candidate conversation. Defaults to 256, from 1 to 1024. */
  readonly maximumHistoryRecords?: number;
  /** Shared limit on concurrent inference in both directions. Defaults to 4, from 1 to 32. */
  readonly maximumConcurrentChecks?: number;
  readonly text?: {
    /** Additional rules fixed for this process. Defaults to an empty list. */
    readonly fixedRules?: readonly TextRule[];
    /** Seeds only a missing editable document. Defaults to an empty list. */
    readonly initialRules?: readonly TextRule[];
    readonly provider: DecisionProvider;
    readonly settings: TextPolicySettings;
  };
}

/** The live reference changes only after a persisted policy activation. */
export interface InstalledFirewall {
  readonly current: () => InstalledFirewall;
  readonly policy: FirewallPolicyOperations;
  readonly configuration: FirewallConfiguration;
  readonly configurationDigest: string;
  readonly metadata: FirewallInstallation;
  readonly firewall: Firewall;
  readonly permits: Effect.Semaphore;
}

/** Fixed process options and the inference semaphore are captured once. */
export const captureInstallation = Effect.fn("captureInstallation")(function* (
  options: FirewallOptions,
) {
  const configuration = yield* decodeFrozen(firewallConfigurationSchema, {
    mode: options.mode,
    facts: options.facts,
    codeDigest: options.codeDigest,
    maximumHistoryRecords: options.maximumHistoryRecords ?? 256,
    maximumConcurrentChecks: options.maximumConcurrentChecks ?? 4,
  }).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new CheckInputError({ reason: "settings" })),
    ),
  );
  const settings = yield* decodeFrozen(FirewallSettings, options.settings).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new CheckInputError({ reason: "settings" })),
    ),
  );
  const incoming = yield* Effect.forEach(
    options.incoming,
    captureRegistration,
    { concurrency: 1 },
  );
  const outgoing = yield* Effect.forEach(
    options.outgoing,
    captureRegistration,
    { concurrency: 1 },
  );
  return Object.freeze({
    configuration,
    settings,
    incoming: Object.freeze(incoming),
    outgoing: Object.freeze(outgoing),
    permits: yield* Effect.makeSemaphore(configuration.maximumConcurrentChecks),
  });
});

/** Editable activations replace only the chain, metadata and digest, retaining process resources. */
export const buildFirewall = Effect.fn("buildFirewall")(function* (
  captured: Effect.Effect.Success<ReturnType<typeof captureInstallation>>,
  incoming: readonly MessageMiddleware[],
  outgoing: readonly MessageMiddleware[],
) {
  const { configuration, settings, permits } = captured;
  const registration = ({
    id,
    revision,
    rules,
    provenance,
  }: MessageMiddleware) =>
    Object.freeze({
      id,
      revision,
      rules,
      provenance: provenance ?? {
        format: "unavailable",
        data: "No descriptive provenance was declared.",
      },
    });
  const metadata = Object.freeze({
    configuration,
    settings,
    incoming: Object.freeze(incoming.map(registration)),
    outgoing: Object.freeze(outgoing.map(registration)),
  });
  const firewall = yield* makeCapturedFirewall({
    incoming,
    outgoing,
    settings,
  });
  const bytes = yield* encodeRuntimeValue(metadata).pipe(
    Effect.catchTag("EndpointStoreError", () =>
      Effect.fail(new CheckInputError({ reason: "registration" })),
    ),
  );
  return Object.freeze({
    configuration,
    metadata,
    configurationDigest: createHash("sha256").update(bytes).digest("hex"),
    firewall,
    permits,
  });
});
