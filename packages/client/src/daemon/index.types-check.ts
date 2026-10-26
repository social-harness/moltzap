/**
 * @file Process factories expose discard Layers and a closed startup error,
 * keeping private daemon services outside the trusted composition boundary.
 * Message-policy writers use current rule kinds so migration cannot broaden authored policy.
 */

import type { Effect, Layer, Types } from "effect";
import type {
  CheckInputError,
  Daemon,
  MessagePolicy,
  messagePolicyFirewall,
} from "./index.js";

type Expect<Value extends true> = Value;

type NamespaceIsExact = Expect<
  Types.Equals<
    keyof typeof Daemon,
    "StartupError" | "help" | "layer" | "withFirewall"
  >
>;
type StartupValue = InstanceType<typeof Daemon.StartupError>;
type StartupTagIsExact = Expect<
  Types.Equals<StartupValue["_tag"], "DaemonStartupError">
>;
type StartupPhaseIsExact = Expect<
  Types.Equals<StartupValue["phase"], "configuration" | "storage" | "listener">
>;
type StartupReasonIsExact = Expect<
  Types.Equals<
    StartupValue["reason"],
    "outbox-too-old" | "newer-schema" | "pre-reset" | "legacy-key" | undefined
  >
>;
type StartupDetailIsExact = Expect<
  Types.Equals<StartupValue["detail"], string | undefined>
>;
type HelpIsExact = Expect<Types.Equals<typeof Daemon.help, string>>;
type LayerIsExact = Expect<
  Types.Equals<typeof Daemon.layer, Layer.Layer<never, Daemon.StartupError>>
>;
type AuditPathIsOptional = Expect<
  Types.Equals<Daemon.FirewallOptions["auditExport"], string | undefined>
>;
/** A document always names a firewall mode; a daemon without one has no firewall. */
type PolicyModeIsExact = Expect<
  Types.Equals<MessagePolicy["mode"], "guidance" | "enforcement">
>;
type EncodedEnglish = NonNullable<(typeof MessagePolicy.Encoded)["english"]>;
type PolicyWriterKindsAreExact = Expect<
  Types.Equals<
    NonNullable<EncodedEnglish["fixedRules"]>[number]["kind"],
    "safety" | "norm"
  >
>;
/** A decoded document installs through the same options as `withFirewall`. */
type PolicyInstallsAsFirewall = Expect<
  Types.Equals<
    ReturnType<typeof messagePolicyFirewall>,
    Effect.Effect<Omit<Daemon.FirewallOptions, "auditExport">, CheckInputError>
  >
>;

/** Compile-time witnesses for the closed Client process boundary. */
export type DaemonCanaries = [
  NamespaceIsExact,
  StartupTagIsExact,
  StartupPhaseIsExact,
  StartupReasonIsExact,
  StartupDetailIsExact,
  HelpIsExact,
  LayerIsExact,
  AuditPathIsOptional,
  PolicyModeIsExact,
  PolicyWriterKindsAreExact,
  PolicyInstallsAsFirewall,
];
