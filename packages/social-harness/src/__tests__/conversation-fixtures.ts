/** @file Verified agents and real SQL for conversation engine tests. */
import { SqlClient } from "@effect/sql";
import { Deferred, Effect, Schema } from "effect";
import { generateKeyPairSync } from "node:crypto";

import { makeEndpointEngine } from "../communication/conversations/index.js";
import {
  deriveConversationId,
  MembershipDescriptor,
  verifyMembershipDescriptor,
} from "../communication/records/index.js";
import { RouterInstanceId } from "../communication/router/api/contract.js";
import { encodeCanonical } from "../encoding/canonical-json.js";
import { AgentCard } from "../identity/cards.js";
import { Ed25519PublicKey } from "../identity/keys.js";
import { WIRE_VERSION } from "../identity/wire-version.js";
import {
  identifier,
  issueTestCard,
  makeTestAuthority,
} from "./agent-card-fixtures.js";
import {
  buildCertifiedFirstMessage,
  storeCertifiedFirstMessage,
} from "./certified-history-fixtures.js";
import { openTestDatabase } from "./communication-test-database.js";
import { pollCursor } from "./router-worker-fixtures.js";
import { stateDirectory } from "./store-schema-fixtures.js";

const anchor = {
  routerInstanceId: Schema.decodeUnknownSync(RouterInstanceId)(
    identifier("rti_", 10),
  ),
  pollCursor: pollCursor(11),
};

const identities = Effect.gen(function* () {
  const registryKeys = generateKeyPairSync("ed25519");
  const local = yield* signingIdentity(1, "alice", registryKeys);
  const remote = yield* signingIdentity(2, "bob", registryKeys);
  const third = yield* signingIdentity(3, "carol", registryKeys);
  const signer = yield* Schema.decodeUnknown(Ed25519PublicKey)(
    registryKeys.publicKey.export({ format: "jwk" }),
  );
  const membership = yield* directMembership([local.card, remote.card], signer);
  const directory = stateDirectory();
  const { sql, run, store } = yield* openTestDatabase(directory);
  yield* run(
    store.bindIdentity({
      agentId: local.card.agentId,
      canonicalAgentCard: yield* encodeCanonical(AgentCard, local.card),
    }),
  );
  return {
    local,
    remote,
    third,
    membership,
    directory,
    store,
    sql,
    run,
    registryKeys,
    signer,
  };
});

/** Real storage and send preparation suspend network delivery at the Router boundary. */
export const engineFixture = () =>
  Effect.gen(function* () {
    const known = yield* identities;
    const { local, remote, third, signer } = known;
    const outbound = yield* Deferred.make<undefined>();
    const engine = yield* makeEndpointEngine({
      localAgentCard: local.card,
      signingAuthority: local.authority,
      registrySignerPublicKey: signer,
      registry: {
        lookup: (request) =>
          Effect.succeed({
            kind: "found",
            agentCard:
              "agentName" in request &&
              request.agentName === third.card.agentName
                ? third.card
                : remote.card,
          }),
      },
      reportStorageFault: () => Effect.dieMessage("unexpected store fault"),
      routerWorker: {
        currentAnchor: Effect.succeed(anchor),
        awaitAnchor: Effect.succeed(anchor),
        send: () =>
          Deferred.succeed(outbound, undefined).pipe(
            Effect.zipRight(Effect.never),
          ),
      },
    }).pipe(Effect.provideService(SqlClient.SqlClient, known.sql));
    return { ...known, engine, outbound };
  }).pipe(Effect.withSpan("fixture"));

/** The fixture whose engine signs every proposal. */
export const fixture = engineFixture();

/** The acquired identities and storage remain live for the test scope. */
export type Fixture = Effect.Effect.Success<typeof fixture>;

/** Carol supplies an independent conversation using the same endpoint store. */
export function addConversation(subject: Fixture, authoredLocally = false) {
  return Effect.gen(function* () {
    const { authority, card } = subject.third;
    const membership = yield* directMembership(
      [subject.local.card, card],
      subject.signer,
    );
    const authors = authoredLocally
      ? { local: { card, authority }, remote: subject.local }
      : { local: subject.local, remote: { card, authority } };
    const record = yield* buildCertifiedFirstMessage(
      authors.local,
      authors.remote,
      membership,
      anchor.routerInstanceId,
    );
    yield* storeCertifiedFirstMessage(
      subject.store,
      subject.local.card,
      membership,
      record,
    );
    return { membership, record, remote: { card, authority } };
  }).pipe(
    Effect.provideService(SqlClient.SqlClient, subject.sql),
    Effect.withSpan("addConversation"),
  );
}

/** A signed FIRST_MESSAGE seeds the default conversation without network traffic. */
export function seedIncoming(subject: Fixture, authoredLocally = false) {
  return Effect.gen(function* () {
    const { local, remote, membership, store } = subject;
    const record = yield* buildCertifiedFirstMessage(
      authoredLocally ? remote : local,
      authoredLocally ? local : remote,
      membership,
      anchor.routerInstanceId,
    );
    yield* storeCertifiedFirstMessage(store, local.card, membership, record);
    return record;
  }).pipe(
    Effect.provideService(SqlClient.SqlClient, subject.sql),
    Effect.withSpan("seedIncoming"),
  );
}

/** One test agent's signing authority and the card the test Registry issued it. */
function signingIdentity(
  byte: number,
  name: string,
  registryKeys: Parameters<typeof issueTestCard>[0]["registryKeys"],
) {
  return Effect.gen(function* () {
    const authority = yield* makeTestAuthority();
    return {
      authority,
      card: yield* issueTestCard({ byte, name, authority, registryKeys }),
    };
  });
}

/** The verified membership of the direct conversation between two cards. */
function directMembership(
  cards: readonly [AgentCard, AgentCard],
  signer: Ed25519PublicKey,
) {
  return Effect.gen(function* () {
    const descriptor = yield* Schema.decodeUnknown(MembershipDescriptor)({
      sharnessVersion: WIRE_VERSION,
      kind: "membership_descriptor",
      conversationId: yield* deriveConversationId([
        cards[0].agentId,
        cards[1].agentId,
      ]),
      members: [
        yield* Schema.encode(AgentCard)(cards[0]),
        yield* Schema.encode(AgentCard)(cards[1]),
      ],
    });
    return yield* verifyMembershipDescriptor(descriptor, signer);
  });
}
