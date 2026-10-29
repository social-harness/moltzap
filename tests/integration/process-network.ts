/** @file Promise-native access to scoped process fixtures for node:test consumers. */
import {
  type InboundItem,
  MessageAddressInput,
  type SendResult,
} from "@moltzap/social-harness";
import { Effect, Exit, Schema, Scope } from "effect";
import {
  acquireDaemonManagementClient,
  acquireProcessInfrastructure,
  type DaemonProcessFixture,
  makeDaemonProcessFixture,
  type ProcessTestError,
} from "./daemon-process-harness.ts";
import {
  joinParticipant,
  nextItem,
  registerFixture,
  send,
} from "./participants.ts";

/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/promise-type -- node:test consumes promises at the fixture boundary. */

/** A registered daemon's coordinates, shared with a host container. */
interface Daemon {
  readonly address: string;
  readonly mcp: URL;
}

/** A participant with acknowledged inbound delivery and management history. */
export interface Endpoint extends Daemon {
  readonly send: (input: unknown) => Promise<SendResult>;
  readonly next: (count: number) => Promise<readonly InboundItem[]>;
  readonly history: (address: string) => Promise<readonly unknown[]>;
}

/** One scope owns the infrastructure, daemons and participant subscriptions. */
export interface Network {
  readonly daemon: (name: string) => Promise<Daemon>;
  readonly endpoint: (name: string) => Promise<Endpoint>;
  readonly holdRouter: () => Promise<() => void>;
  readonly close: () => Promise<undefined>;
}

/** A consumer may run a fixture in its own container while sharing registration and participants. */
type StartDaemon = (
  fixture: DaemonProcessFixture,
) => Effect.Effect<unknown, ProcessTestError, Scope.Scope>;

/** Acquires the shared process network, closing partial startup on failure. */
export async function startNetwork(startDaemon: StartDaemon): Promise<Network> {
  const scope = Effect.runSync(Scope.make());
  const close = () =>
    Effect.runPromise(Scope.close(scope, Exit.void).pipe(Effect.as(undefined)));
  try {
    const infrastructure = await runInScope(
      scope,
      acquireProcessInfrastructure,
    );
    const daemon = (name: string) =>
      runInScope(
        scope,
        makeDaemonProcessFixture(infrastructure, name).pipe(
          Effect.tap(startDaemon),
          Effect.tap(registerFixture),
        ),
      );
    return {
      daemon: async (name) => {
        const fixture = await daemon(name);
        return { address: `agent:${fixture.agentName}`, mcp: fixture.endpoint };
      },
      endpoint: async (name) =>
        await networkEndpoint(scope, await daemon(name)),
      holdRouter: () => runInScope(scope, infrastructure.holdRouter),
      close,
    };
  } catch (cause) {
    await close();
    throw cause;
  }
}

async function networkEndpoint(
  scope: Scope.CloseableScope,
  fixture: DaemonProcessFixture,
): Promise<Endpoint> {
  const participant = await runInScope(scope, joinParticipant(fixture));
  return {
    address: participant.address,
    mcp: fixture.endpoint,
    send: (input) => runInScope(scope, send(participant, input)),
    next: (count) =>
      runInScope(
        scope,
        Effect.forEach(
          Array.from({ length: count }),
          () => nextItem(participant),
          { concurrency: 1 },
        ).pipe(Effect.timeout("60 seconds")),
      ),
    history: (address) => runInScope(scope, readContents(fixture, address)),
  };
}

function readContents(fixture: DaemonProcessFixture, address: string) {
  return Effect.scoped(
    acquireDaemonManagementClient(fixture.endpoint).pipe(
      Effect.flatMap((management) =>
        management.readConversation(
          Schema.decodeUnknownSync(MessageAddressInput)(address),
        ),
      ),
      Effect.map((result) =>
        result.records.map(
          (record) => record.recordCore.action.postIntent.content,
        ),
      ),
    ),
  );
}

function runInScope<A, E>(
  scope: Scope.CloseableScope,
  effect: Effect.Effect<A, E, Scope.Scope>,
) {
  return Effect.runPromise(Scope.extend(effect, scope));
}

/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/promise-type -- Restore Effect-only application boundaries. */
