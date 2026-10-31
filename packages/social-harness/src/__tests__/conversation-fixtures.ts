/** @file Verified agents and real SQL for conversation engine tests. */
import { SqlClient } from "@effect/sql";
import { Effect, Schema } from "effect";
import { generateKeyPairSync } from "node:crypto";

import { messageFromIntent } from "../communication/message.js";
import {
  type Content,
  deriveConversationId,
  MembershipDescriptor,
  mintMsgId,
  type MsgId,
  verifyMembershipDescriptor,
} from "../communication/records/index.js";
import { RouterInstanceId } from "../communication/router/api/contract.js";
import { encodeCanonical } from "../encoding/canonical-json.js";
import { AgentCard, type AgentView, agentViewOf } from "../identity/cards.js";
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

/** Verified signers share a Registry authority and one isolated durable store. */
export const conversationIdentityFixture = Effect.gen(function* () {
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
    anchor,
  };
}).pipe(Effect.withSpan("conversationIdentityFixture"));

/** The acquired identities and storage remain live for the test scope. */
export type Fixture = Effect.Effect.Success<typeof conversationIdentityFixture>;

/** Each call creates a distinct send unless a retry supplies the same message id. */
export function authoredMessage(
  subject: Pick<Fixture, "local" | "remote">,
  content: Content,
  options: {
    readonly recipients?: readonly AgentView[];
    readonly msgId?: MsgId;
  } = {},
) {
  return Effect.gen(function* () {
    return yield* messageFromIntent(
      [
        agentViewOf(subject.local.card),
        ...(options.recipients ?? [agentViewOf(subject.remote.card)]),
      ],
      {
        authorAgentId: subject.local.card.agentId,
        msgId: options.msgId ?? (yield* mintMsgId()),
        content,
      },
    );
  }).pipe(Effect.orDie, Effect.withSpan("authoredMessage"));
}

/** A signed FIRST_MESSAGE seeds the default conversation without network traffic. */
export function seedIncoming(
  subject: Pick<Fixture, "local" | "remote" | "membership" | "store" | "sql">,
  authoredLocally = false,
) {
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
