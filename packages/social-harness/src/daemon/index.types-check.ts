/**
 * @file Process factories expose discard Layers and a closed startup error,
 * keeping private daemon services outside the trusted composition boundary.
 * Message-policy writers share the rule kinds the installed firewall evaluates.
 */

import type { Effect, Layer, Option, Types } from "effect";
import type {
  checkMessage,
  Daemon,
  MessagePolicy,
  loadMessagePolicy,
  makeFirewall,
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
  Types.Equals<
    StartupValue["phase"],
    "configuration" | "storage" | "listener" | "registration"
  >
>;
type StartupReasonIsExact = Expect<
  Types.Equals<
    StartupValue["reason"],
    | "outbox-too-old"
    | "incompatible"
    | "agent-not-admitted"
    | "admission-refused"
    | "name_taken"
    | "key_already_registered"
    | "idempotency_conflict"
    | "dependency-unavailable"
    | "persistence-failed"
    | "incompatible-daemon"
    | undefined
  >
>;
type StartupDetailIsExact = Expect<
  Types.Equals<StartupValue["detail"], string | undefined>
>;
type HelpIsExact = Expect<Types.Equals<typeof Daemon.help, string>>;
type LayerIsExact = Expect<
  Types.Equals<typeof Daemon.layer, Layer.Layer<never, Daemon.StartupError>>
>;
/** A document always names a firewall mode; a daemon without one has no firewall. */
type PolicyModeIsExact = Expect<
  Types.Equals<MessagePolicy["mode"], "guidance" | "enforcement">
>;
type EncodedText = NonNullable<(typeof MessagePolicy.Encoded)["text"]>;
type PolicyWriterDirectionsAreExact = Expect<
  Types.Equals<
    NonNullable<EncodedText["fixedRules"]>[number]["applies"],
    "incoming" | "outgoing" | "both"
  >
>;
/** Loaded policy parameters enter the same constructor as trusted code configuration. */
type LoadedPolicyInstalls = Expect<
  Effect.Effect.Success<
    ReturnType<typeof loadMessagePolicy>
  > extends Option.Option<Parameters<typeof makeFirewall>[0]>
    ? true
    : false
>;

/** Offline evaluation consumes its explicit inputs without a daemon service requirement. */
type OfflineCheckNeedsNoService = Expect<
  Types.Equals<Effect.Effect.Context<ReturnType<typeof checkMessage>>, never>
>;

/** Inline-only Text blocks remain valid trusted composition inputs. */
type InlineTextIsAssignable = Expect<
  {
    readonly fixedRules: readonly [];
    readonly initialRules: readonly [];
  } extends MessagePolicy["text"]
    ? true
    : false
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
  PolicyModeIsExact,
  PolicyWriterDirectionsAreExact,
  LoadedPolicyInstalls,
  OfflineCheckNeedsNoService,
  InlineTextIsAssignable,
];
