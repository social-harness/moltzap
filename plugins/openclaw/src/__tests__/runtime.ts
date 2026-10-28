/** @file Records turns from OpenClaw's public inbound runner without invoking a model. */

import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { Data, Effect } from "effect";
import {
  buildChannelInboundEventContext,
  type ChannelInboundEventRunnerParams,
  type ChannelInboundTurnPlan,
  runChannelInboundEvent,
} from "openclaw/plugin-sdk/channel-inbound";

/** One test account owns all generated routes. */
export const ACCOUNT_ID = "primary";
/** Shared mode selects the host's main session. */
export const MAIN_SESSION_KEY = "agent:primary:main";

type OpenClawInboundRunInput = ChannelInboundEventRunnerParams<{
  readonly turn: object;
}>;
type ResolvedInboundTurn = Awaited<
  ReturnType<OpenClawInboundRunInput["adapter"]["resolveTurn"]>
>;

interface ObservedAccountRuntime extends ChannelRuntimeSurface {
  readonly inbound: {
    readonly buildContext: PluginRuntime["channel"]["inbound"]["buildContext"];
    readonly run: (
      input: OpenClawInboundRunInput,
    ) => ReturnType<typeof runChannelInboundEvent>;
  };
  readonly routing: Pick<
    PluginRuntime["channel"]["routing"],
    "resolveAgentRoute"
  >;
}

/** Captures the model-facing context and host reply options at dispatch. */
export interface DispatchObservation {
  readonly ctx: ChannelInboundTurnPlan["ctxPayload"];
  readonly replyOptions: ChannelInboundTurnPlan["replyOptions"];
}

/** The caller owns observation buffers and optional injected dispatch failure. */
export interface RuntimeFixtureParams {
  readonly events: string[];
  readonly calls: DispatchObservation[];
  readonly routePeers: Array<{
    readonly kind: string;
    readonly id: string;
  } | null>;
  readonly failDispatch?: boolean;
  readonly plans?: ChannelInboundTurnPlan[];
  readonly replyText?: string;
}

/** Keeps host callback failures distinct from Client send refusals. */
export class OpenClawTestError extends Data.TaggedError("OpenClawTestError")<{
  readonly operation: string;
  readonly detail: string;
}> {
  override get message(): string {
    return `${this.operation} failed: ${this.detail}`;
  }
}

/** Uses the real inbound runner with an observed route and reply dispatcher. */
export function makeObservedRuntime(
  params: RuntimeFixtureParams,
): ObservedAccountRuntime {
  return {
    runtimeContexts: {
      register: () => ({ dispose: () => undefined }),
      get: () => undefined,
      watch: () => () => undefined,
    },
    inbound: {
      buildContext: buildChannelInboundEventContext,
      run: observedOpenClawInboundRunner(params),
    },
    routing: makeRoutingRuntime(params),
  };
}

/** Promise errors retain their operation and printable host detail for assertions. */
export function testError(
  operation: string,
  cause: unknown,
): OpenClawTestError {
  return new OpenClawTestError({ operation, detail: String(cause) });
}

/** Private mode uses the route selected by the host for the canonical peer. */
export function sessionKeyForPeer(kind: string, id: string): string {
  return `agent:primary:sharness:${kind}:${id}`;
}

function observedOpenClawInboundRunner(
  params: RuntimeFixtureParams,
): ObservedAccountRuntime["inbound"]["run"] {
  return (input) =>
    runChannelInboundEvent({
      ...input,
      adapter: {
        ...input.adapter,
        resolveTurn: (normalized, eventClass, preflight) =>
          Effect.runPromise(
            Effect.tryPromise({
              try: () =>
                Promise.resolve(
                  input.adapter.resolveTurn(normalized, eventClass, preflight),
                ),
              catch: (cause) => testError("resolveTurn", cause),
            }).pipe(Effect.map((resolved) => observedTurn(params, resolved))),
          ),
      },
      log: (event) => {
        if (event.stage === "record" && event.event === "done") {
          params.events.push(
            `record:${event.messageId ?? "missing"}:${event.sessionKey ?? "missing"}`,
          );
        }
      },
    });
}

function observedTurn(
  params: RuntimeFixtureParams,
  resolved: ResolvedInboundTurn,
): ChannelInboundTurnPlan {
  const turn = requireRoutedTurnPlan(resolved);
  params.plans?.push(turn);
  return {
    ...turn,
    dispatchReplyFromConfig: observedReplyDispatch(params),
  };
}

function requireRoutedTurnPlan(
  turn: ResolvedInboundTurn,
): ChannelInboundTurnPlan {
  if (
    !("route" in turn) ||
    !("delivery" in turn) ||
    !("deliver" in turn.delivery) ||
    typeof turn.delivery.deliver !== "function"
  ) {
    throw new Error("expected a core-managed routed inbound turn");
  }
  return turn;
}

function makeRoutingRuntime(
  params: RuntimeFixtureParams,
): ObservedAccountRuntime["routing"] {
  return {
    resolveAgentRoute: (input) => {
      params.routePeers.push(input.peer ?? null);
      return {
        agentId: "primary",
        channel: "sharness",
        accountId: input.accountId ?? ACCOUNT_ID,
        sessionKey:
          input.peer === undefined || input.peer === null
            ? MAIN_SESSION_KEY
            : sessionKeyForPeer(input.peer.kind, input.peer.id),
        mainSessionKey: MAIN_SESSION_KEY,
        lastRoutePolicy: "session",
        matchedBy: "default",
      };
    },
  };
}

function observedReplyDispatch(
  params: RuntimeFixtureParams,
): NonNullable<ChannelInboundTurnPlan["dispatchReplyFromConfig"]> {
  return ({ ctx, dispatcher, replyOptions }) => {
    const messageId = ctx.MessageSid ?? "missing";
    params.calls.push({ ctx, replyOptions });
    if (params.failDispatch === true) {
      params.events.push(`dispatch-failed:${messageId}`);
      return Promise.reject(testError("dispatch", "OpenClaw turn failed"));
    }
    const text = params.replyText ?? "host final";
    params.events.push(`dispatch:${messageId}`);
    const queuedFinal = dispatcher.sendFinalReply({ text });
    return Promise.resolve({
      queuedFinal,
      counts: { tool: 0, block: 0, final: queuedFinal ? 1 : 0 },
    });
  };
}
