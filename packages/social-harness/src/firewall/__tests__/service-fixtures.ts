/** @file Builds registered firewall services against real agent-scoped SQLite storage. */
import { SqliteClient } from "@effect/sql-sqlite-node";
import { type Context, Effect, Encoding, Layer, Redacted } from "effect";
import type { IdentityFixture } from "../../identity/__tests__/authentication-fixtures.js";
import { migrateDaemon } from "../../database/migrations.js";
import {
  type AgentCard,
  agentCardOf,
  AgentSigningAuthority,
} from "../../identity/agent-cards.js";
import { RegistrationId, Registry } from "../../identity/registry.js";
import { Identity } from "../../identity/service.js";
import { Firewall } from "../service.js";

/** Separate acquisitions reuse persisted state while each scope owns its connection and identity. */
export function withFirewall<A, E, R>(
  storage: string | { readonly filename: string; readonly agentKey: string },
  fixture: IdentityFixture,
  use: (
    firewall: Context.Tag.Service<typeof Firewall>,
    self: AgentCard,
  ) => Effect.Effect<A, E, R>,
  configure: (agentKey: string) => ReturnType<typeof Firewall.layer>,
) {
  const filename = typeof storage === "string" ? storage : storage.filename;
  const agentKey = typeof storage === "string" ? storage : storage.agentKey;
  const identity = Identity.layer({
    agentKey,
    signingAuthority: fixture.signingAuthority,
    registrySignerPublicKey: AgentSigningAuthority.publicKey(
      fixture.registryAuthority,
    ),
    admissionCredential: Effect.succeed(Redacted.make("test-admission")),
  }).pipe(
    Layer.provide(
      Layer.succeed(
        Registry,
        Registry.of({
          register: () =>
            Effect.succeed({
              kind: "registered",
              identityCard: fixture.identityCard,
            }),
          lookup: () => Effect.succeed({ kind: "not_found" }),
        }),
      ),
    ),
  );
  const layer = configure(agentKey);
  const services = layer.pipe(
    Layer.provideMerge(identity),
    Layer.provideMerge(
      Layer.effectDiscard(migrateDaemon).pipe(
        Layer.provideMerge(SqliteClient.layer({ filename })),
      ),
    ),
  );
  return Effect.scoped(
    Effect.gen(function* () {
      const local = yield* Identity;
      yield* local.register({
        operationId: RegistrationId.make(
          `opn_${Encoding.encodeBase64Url(new Uint8Array(16))}`,
        ),
        principalId: fixture.identityCard.principalId,
        agentName: fixture.identityCard.agentName,
      });
      return yield* use(yield* Firewall, agentCardOf(fixture.identityCard));
    }).pipe(Effect.provide(services)),
  ).pipe(Effect.withSpan("withFirewall"));
}
