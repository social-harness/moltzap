/** @file Verified identity and durable-message fixtures for daemon runtime tests. */

import { Effect, Redacted, Schema } from "effect";
import { mcpTestCredential } from "./mcp-http-fixtures.js";
import { generateKeyPairSync } from "node:crypto";
import type { EnginePendingMessage } from "../communication/conversations/index.js";
import type { DaemonBootstrap } from "../daemon/bootstrap.js";
import { InboundMessage } from "../communication/conversations/message.js";
import { RecordHash } from "../communication/records/index.js";
import { DeliveryToken } from "../communication/store/index.js";
import { encodeCanonical } from "../encoding/canonical-json.js";
import { managementRegisterRequestSchema } from "../host-protocol/index.js";
import { AgentCard, type VerifiedAgentCard } from "../identity/cards.js";
import { AgentSigningAuthority, Ed25519PublicKey } from "../identity/keys.js";
import {
  digest,
  identifier,
  issueTestCard,
  makeTestAuthority,
  type RegistryKeyPair,
  testAgentView,
} from "./agent-card-fixtures.js";

/** Binds the daemon bootstrap to the signed identity used by its pending message. */
export interface Fixture {
  readonly bootstrap: DaemonBootstrap;
  readonly localCard: VerifiedAgentCard;
  readonly peerCards: readonly VerifiedAgentCard[];
  readonly canonicalLocalCard: Uint8Array;
  readonly registerRequest: typeof managementRegisterRequestSchema.Type;
  readonly pending: EnginePendingMessage;
}

const makePendingMessage = Effect.all({
  deliveryToken: Schema.decodeUnknown(DeliveryToken)(digest("dlv_", 4)),
  recordHash: Schema.decodeUnknown(RecordHash)(digest("rch_", 6)),
  message: Schema.decodeUnknown(InboundMessage)({
    kind: "direct",
    msgId: digest("msg_", 5),
    address: "agent:bob",
    sender: testAgentView("agent:bob"),
    content: [{ type: "text", text: "certified" }],
  }),
});

const makePeerCards = (registryKeys: RegistryKeyPair) =>
  Effect.forEach(
    ["bob", "carol"],
    (name, index) =>
      Effect.gen(function* () {
        return yield* issueTestCard({
          byte: index + 2,
          name,
          authority: yield* makeTestAuthority(),
          registryKeys,
        });
      }),
    { concurrency: 1 },
  );

/** Supplies a verified local identity and one certified pending delivery. */
export const makeFixture = Effect.gen(function* () {
  const registryKeys = generateKeyPairSync("ed25519");
  const registrySignerPublicKey = yield* Schema.decodeUnknown(Ed25519PublicKey)(
    registryKeys.publicKey.export({ format: "jwk" }),
  );
  const signingAuthority = yield* makeTestAuthority();
  const localCard = yield* issueTestCard({
    byte: 1,
    name: "alice",
    authority: signingAuthority,
    registryKeys,
  });
  const bootstrap: DaemonBootstrap = Object.freeze({
    configuration: {
      stateDirectory: "/var/lib/social-harness",
      mcpPort: 4319,
      mcpCredentialFile: Redacted.make("/run/secrets/mcp-credential"),
      registryOrigin: new URL("https://registry.example"),
      registrySignerPublicKey,
      routerOrigin: new URL("https://router.example"),
      agentPrivateKeyFile: Redacted.make("/run/secrets/agent.pem"),
      admissionCredentialFile: Redacted.make("/run/secrets/admission"),
      hideGroups: false,
      hideCollectives: false,
    },
    signingAuthority,
    mcpCredential: mcpTestCredential,
    agentPublicKey: AgentSigningAuthority.publicKey(signingAuthority),
    admissionCredential: Effect.succeed(Redacted.make("bootstrap-token=")),
  });
  const registerRequest = yield* Schema.decodeUnknown(
    managementRegisterRequestSchema,
  )({
    operationId: identifier("opn_", 3),
    principalId: localCard.principalId,
    agentName: localCard.agentName,
  });
  return {
    bootstrap,
    localCard,
    peerCards: yield* makePeerCards(registryKeys),
    canonicalLocalCard: yield* encodeCanonical(AgentCard, localCard),
    registerRequest,
    pending: yield* makePendingMessage,
  } satisfies Fixture;
}).pipe(Effect.orDie, Effect.withSpan("makeFixture"));
