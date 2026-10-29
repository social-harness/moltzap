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
  makeRegistrationRequest,
  type ProcessTestError,
} from "./daemon-process-harness.ts";
import { joinParticipant, nextItem, send } from "./participants.ts";

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

/** Starts one fixture's daemon, which a consumer may run in its own container; the fixture's environment carries its startup registration. */
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
          Effect.map(withStartupRegistration),
          Effect.tap(startDaemon),
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

/**
 * Hosting starts a daemon with its registration in the environment, and the
 * daemon registers before it listens, so a started fixture is registered.
 */
function withStartupRegistration(
  fixture: DaemonProcessFixture,
): DaemonProcessFixture {
  const registration = makeRegistrationRequest(fixture);
  return {
    ...fixture,
    environment: {
      ...fixture.environment,
      SHARNESS_REGISTRATION_AGENT_NAME: registration.agentName,
      SHARNESS_REGISTRATION_OPERATION_ID: registration.operationId,
      SHARNESS_REGISTRATION_PRINCIPAL_ID: registration.principalId,
    },
  };
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
