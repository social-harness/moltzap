/** @file Host messaging fixtures compose the real services over signed agents and isolated SQLite. */

import { SqlClient } from "@effect/sql";
import { Context, Deferred, Effect, FiberSet, Layer } from "effect";
import type { conversationIdentityFixture } from "./conversation-fixtures.js";
import { Collectives } from "../communication/collectives/index.js";
import { Communication } from "../communication/index.js";
import { Router } from "../communication/router/index.js";
import { communicationLive } from "../communication/service/index.js";
import {
  type HistoryExportPort,
  noHistoryExport,
} from "../daemon/inbox/host-traffic-log.js";
import {
  HostMessaging,
  hostMessagingLayer,
} from "../daemon/messaging/index.js";
import { Firewall, type FirewallOptions } from "../firewall/index.js";
import { AgentSigningAuthority } from "../identity/keys.js";
import { saveLocalIdentity } from "../identity/local-store.js";
import { localIdentityLayer } from "../identity/local.js";
import { Registry } from "../identity/registry/index.js";
import { emptyBatch } from "./router-worker-fixtures.js";

type Subject = Effect.Effect.Success<typeof conversationIdentityFixture>;
interface HostFixtureOptions {
  readonly firewall?: FirewallOptions;
  readonly communication?: Context.Tag.Service<typeof Communication>;
  readonly historyExport?: HistoryExportPort;
  readonly experiments?: {
    readonly hideGroups: boolean;
    readonly hideCollectives: boolean;
  };
  readonly router?: Context.Tag.Service<typeof Router>;
}

/** The captured outbound edge pauses delivery after the real protocol persists a send. */
export function makeHostMessagingFixture(
  subject: Subject,
  options: HostFixtureOptions = {},
) {
  return Effect.gen(function* () {
    yield* subject.run(saveLocalIdentity(subject.local.card));
    const workers = yield* FiberSet.make<never>();
    const outbound = yield* Deferred.make<undefined>();
    const identity = identityFor(
      subject,
      options.router ?? pausedRouter(subject, outbound),
    );
    const communication = (
      options.communication === undefined
        ? communicationLive(
            {
              signingAuthority: subject.local.authority,
              registrySignerPublicKey: subject.signer,
            },
            workers,
          )
        : Layer.succeed(Communication, options.communication)
    ).pipe(Layer.provideMerge(identity));
    const collectives = Collectives.layer.pipe(
      Layer.provideMerge(communication),
    );
    const firewall = Firewall.layer(options.firewall).pipe(
      Layer.provideMerge(collectives),
    );
    const context = yield* Layer.build(
      hostMessagingLayer(
        {
          registrySignerPublicKey: subject.signer,
          historyExport: options.historyExport ?? noHistoryExport,
          ...(options.experiments === undefined
            ? {}
            : { experiments: options.experiments }),
        },
        workers,
      ).pipe(Layer.provideMerge(firewall)),
    );
    return {
      subject,
      context,
      workers,
      outbound,
      messaging: Context.get(context, HostMessaging),
    };
  }).pipe(Effect.withSpan("makeHostMessagingFixture"));
}

function pausedRouter(
  subject: Subject,
  outbound: Deferred.Deferred<undefined>,
) {
  return Router.of({
    poll: ({ request }) =>
      request.pollCursor === undefined
        ? Effect.succeed(
            emptyBatch(
              subject.anchor.routerInstanceId,
              subject.anchor.pollCursor,
            ),
          )
        : Effect.never,
    send: () =>
      Deferred.succeed(outbound, undefined).pipe(Effect.zipRight(Effect.never)),
  });
}

function identityFor(
  subject: Subject,
  router: Context.Tag.Service<typeof Router>,
) {
  const dependencies = Layer.mergeAll(
    Layer.succeed(SqlClient.SqlClient, subject.sql),
    Layer.succeed(Registry, registryFor(subject)),
    Layer.succeed(Router, router),
  );
  return localIdentityLayer({
    signingAuthority: subject.local.authority,
    registrySignerPublicKey: subject.signer,
    agentPublicKey: AgentSigningAuthority.publicKey(subject.local.authority),
    admissionCredential: Effect.dieMessage(
      "The host fixture is already registered",
    ),
  }).pipe(Layer.provideMerge(dependencies));
}

function registryFor(subject: Subject) {
  return Registry.of({
    register: () => Effect.dieMessage("The host fixture is already registered"),
    lookup: (request) => {
      const card = [
        subject.local.card,
        subject.remote.card,
        subject.third.card,
      ].find((candidate) =>
        "agentName" in request
          ? candidate.agentName === request.agentName
          : candidate.agentId === request.agentId,
      );
      return Effect.succeed(
        card === undefined
          ? { kind: "not_found" as const }
          : { kind: "found" as const, agentCard: card },
      );
    },
  });
}
