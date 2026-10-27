/**
 * @file Rebuild retained Client records after pnpm build:
 * node scripts/generate-client-record-golden.ts.
 * Two-member forms rebuild from retained signed inputs whose keys were not kept;
 * N4 forms sign under public deterministic test seeds. Neither fixture contains
 * production key material.
 */

import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Redacted, Schema } from "effect";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import {
  ActionCertifiedRecord,
  ActionCore,
  CertifiedRecord,
  CompletedReanchor,
  deriveConversationId,
  DirectPacket,
  type EvidenceStatement,
  GenesisAnchorBody,
  hashAction,
  hashAnchor,
  hashMembershipDescriptor,
  hashPostIntent,
  hashRecord,
  MembershipDescriptor,
  PostId,
  PostIntent,
  quorumThreshold,
  ReanchorBody,
  RecordCore,
  RecordHash,
  signEvidenceMessage,
} from "../packages/client/dist/communication/records/index.js";
import { RouterInstanceId } from "../packages/client/dist/communication/router/api/index.js";
import { encodeCanonical } from "../packages/client/dist/encoding/canonical-json.js";
import { WireVersions } from "../packages/client/dist/identity/wire-version.js";
import {
  AgentCard,
  AgentId,
  AgentName,
  AgentSigningAuthority,
  Ed25519PublicKey,
  PrincipalId,
  SignedMessage,
} from "../packages/client/dist/index.js";
import captured from "./client-record-golden-inputs.json" with { type: "json" };

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier, {
      ...context,
      conditions: [...context.conditions, "sharness-internal"],
    });
  },
});

const { AgentCardIssuedAt: agentCardIssuedAt, issueAgentCard } = await import(
  "../packages/registry/dist/issuance.js"
);

const sharnessVersion = "2026.1021.3";
const utf8 = new TextDecoder();

/** Public repeated-byte seeds are exclusively synthetic test keys. */
function testAuthority(byte: number) {
  const der = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.alloc(32, byte),
  ]);
  return AgentSigningAuthority.fromPkcs8(
    Redacted.make(
      `-----BEGIN PRIVATE KEY-----\n${der.toString("base64")}\n-----END PRIVATE KEY-----\n`,
    ),
  );
}

/** Reconstruct canonical cores independently of the retained signatures. */
function recordCore(
  action: ActionCore,
  routerAnchor: ActionCertifiedRecord["routerAnchor"],
) {
  return Effect.gen(function* () {
    return yield* Schema.decodeUnknown(RecordCore)({
      sharnessVersion,
      kind: "record_core",
      ...(action.kind === "GENESIS"
        ? { membership: action.membership }
        : { membershipHash: action.membershipHash }),
      anchorHash:
        routerAnchor.kind === "genesis_anchor_body"
          ? yield* hashAnchor(routerAnchor)
          : routerAnchor.anchorHash,
      action,
      actionHash: yield* hashAction(action),
    });
  });
}

/** Build both wrappers with evidence excluded from the hashes. */
function records(
  core: RecordCore,
  routerAnchor: ActionCertifiedRecord["routerAnchor"],
  signatures: readonly unknown[],
  votes: readonly unknown[],
) {
  return Effect.gen(function* () {
    const recordHash = yield* hashRecord(core);
    const actionCertified = yield* Schema.decodeUnknown(ActionCertifiedRecord)({
      sharnessVersion,
      kind: "action_certified_record",
      recordHash,
      recordCore: core,
      routerAnchor,
      actionCertificate: {
        sharnessVersion,
        kind: "action_certificate",
        actionHash: core.actionHash,
        signatures,
      },
    });
    const certified = yield* Schema.decodeUnknown(CertifiedRecord)({
      sharnessVersion,
      kind: "certified_record",
      actionCertifiedRecord: actionCertified,
      durabilityCertificate: {
        sharnessVersion,
        kind: "durability_certificate",
        recordHash,
        votes,
      },
    });
    return { actionCertified, certified };
  });
}

/** Each form carries its own verification context, including the independent N4 membership. */
function form(
  name: string,
  packet: DirectPacket,
  core: RecordCore,
  context: {
    readonly descriptor: MembershipDescriptor;
    readonly registrySignerPublicKey: unknown;
  },
) {
  return Effect.gen(function* () {
    return {
      name,
      kind: packet.kind,
      membership: context.descriptor,
      registrySignerPublicKey: context.registrySignerPublicKey,
      bytes: utf8.decode(yield* encodeCanonical(DirectPacket, packet)),
      recordHash: yield* hashRecord(core),
      actionHash: yield* hashAction(core.action),
    };
  });
}

/** Rebuild two-member forms from retained signed inputs whose keys were not kept. */
const retainedForms = Effect.gen(function* () {
  const membership = yield* Schema.decodeUnknown(MembershipDescriptor)(
    captured.membership,
  );
  return yield* Effect.forEach(
    captured.records,
    (input) =>
      Effect.gen(function* () {
        const action = yield* Schema.decodeUnknown(ActionCore)(input.action);
        const anchor = yield* Schema.decodeUnknown(GenesisAnchorBody)(
          input.routerAnchor,
        );
        const core = yield* recordCore(action, anchor);
        const pair = yield* records(
          core,
          anchor,
          input.signatures,
          input.votes,
        );
        return yield* Effect.all([
          form(`${action.kind} action-certified`, pair.actionCertified, core, {
            descriptor: membership,
            registrySignerPublicKey: captured.registrySignerPublicKey,
          }),
          form(`${action.kind} certified`, pair.certified, core, {
            descriptor: membership,
            registrySignerPublicKey: captured.registrySignerPublicKey,
          }),
        ]);
      }),
    { concurrency: 1 },
  );
});

/** Repeated bytes identify synthetic members independently of their signing keys. */
function agentIdOf(byte: number) {
  return Schema.decodeUnknown(AgentId)(
    `agt_${Buffer.alloc(16, byte).toString("base64url")}`,
  );
}

/** A stable card binds one deterministic member seed to the fixed Registry key. */
function deterministicIdentity(byte: number, registry: AgentSigningAuthority) {
  return Effect.gen(function* () {
    const authority = yield* testAuthority(byte + 10);
    const card = yield* issueAgentCard({
      agentId: yield* agentIdOf(byte),
      principalId: yield* Schema.decodeUnknown(PrincipalId)(
        `prn_${Buffer.alloc(16, byte).toString("base64url")}`,
      ),
      agentName: yield* Schema.decodeUnknown(AgentName)(
        `golden-member-${byte}`,
      ),
      publicKey: AgentSigningAuthority.publicKey(authority),
      issuedAt: yield* Schema.decodeUnknown(agentCardIssuedAt)(
        "2026-08-27T12:00:00Z",
      ),
      registrySigningAuthority: registry,
    });
    return { card, authority };
  });
}

/** Fixed cards and public seeds make N4 signatures reproducible. */
const deterministicFixture = Effect.gen(function* () {
  const registry = yield* testAuthority(1);
  const identities = yield* Effect.forEach(
    [1, 2, 3, 4],
    (byte) => deterministicIdentity(byte, registry),
    { concurrency: 1 },
  );
  const descriptor = yield* Schema.decodeUnknown(MembershipDescriptor)({
    sharnessVersion,
    kind: "membership_descriptor",
    conversationId: yield* deriveConversationId([
      yield* agentIdOf(1),
      yield* agentIdOf(2),
      ...identities.slice(2).map(({ card }) => card.agentId),
    ]),
    members: yield* Effect.forEach(
      identities,
      ({ card }) => Schema.encode(AgentCard)(card),
      { concurrency: 1 },
    ),
  });
  return {
    identities,
    descriptor,
    membershipHash: yield* hashMembershipDescriptor(descriptor),
    registrySignerPublicKey: yield* Schema.encode(Ed25519PublicKey)(
      AgentSigningAuthority.publicKey(registry),
    ),
  };
});

/** Canonical signer order and an author-inclusive quorum exercise the N4 rule. */
function signSet(
  fixture: Effect.Effect.Success<typeof deterministicFixture>,
  statement: (signerAgentId: AgentId) => EvidenceStatement,
) {
  return Effect.forEach(
    fixture.identities.slice(0, quorumThreshold(fixture.identities.length)),
    ({ card, authority }) =>
      signEvidenceMessage({
        statement: statement(card.agentId),
        agentCard: card,
        signingAuthority: authority,
      }).pipe(
        Effect.flatMap((message) => Schema.encode(SignedMessage)(message)),
      ),
    { concurrency: 1 },
  );
}

interface PostInput {
  readonly anchor: ActionCertifiedRecord["routerAnchor"];
  readonly previousRecordHash: RecordHash;
  readonly byte: number;
  readonly name: string;
}

/** Build a deterministic POST for either the genesis or completed Router anchor. */
function postAction(
  fixture: Effect.Effect.Success<typeof deterministicFixture>,
  input: PostInput,
) {
  return Effect.gen(function* () {
    const [author] = fixture.identities;
    if (author === undefined) {
      return yield* Effect.dieMessage("missing golden author");
    }
    const intent = yield* Schema.decodeUnknown(PostIntent)({
      sharnessVersion,
      kind: "post_intent",
      conversationId: fixture.descriptor.conversationId,
      membershipHash: fixture.membershipHash,
      authorAgentId: author.card.agentId,
      postId: yield* Schema.decodeUnknown(PostId)(
        `pst_${Buffer.alloc(32, input.byte).toString("base64url")}`,
      ),
      content: [{ type: "text", text: input.name }],
    });
    const action = yield* Schema.decodeUnknown(ActionCore)({
      sharnessVersion,
      kind: "POST",
      conversationId: fixture.descriptor.conversationId,
      membershipHash: fixture.membershipHash,
      anchorHash:
        input.anchor.kind === "genesis_anchor_body"
          ? yield* hashAnchor(input.anchor)
          : input.anchor.anchorHash,
      previousRecordHash: input.previousRecordHash,
      postIntent: intent,
      postIntentHash: yield* hashPostIntent(intent),
    });
    return action;
  });
}

/** Encode both POST wrappers with deterministic quorum evidence. */
function postForms(
  fixture: Effect.Effect.Success<typeof deterministicFixture>,
  input: PostInput,
) {
  return Effect.gen(function* () {
    const action = yield* postAction(fixture, input);
    const core = yield* recordCore(action, input.anchor);
    const recordHash = yield* hashRecord(core);
    const signatures = yield* signSet(fixture, (signerAgentId) => ({
      sharnessVersion,
      kind: "action_signature",
      signerAgentId,
      actionHash: core.actionHash,
    }));
    const votes = yield* signSet(fixture, (signerAgentId) => ({
      sharnessVersion,
      kind: "durability_vote",
      signerAgentId,
      recordHash,
      conversationId: fixture.descriptor.conversationId,
      membershipHash: fixture.membershipHash,
    }));
    const pair = yield* records(core, input.anchor, signatures, votes);
    return {
      recordHash,
      forms: yield* Effect.all([
        form(
          `${input.name} action-certified`,
          pair.actionCertified,
          core,
          fixture,
        ),
        form(`${input.name} certified`, pair.certified, core, fixture),
      ]),
    };
  });
}

/** The re-anchor quorum binds the selected predecessor under the next Router instance. */
function completedAnchor(
  fixture: Effect.Effect.Success<typeof deterministicFixture>,
  anchor: GenesisAnchorBody,
  selectedRecordHash: RecordHash,
) {
  return Effect.gen(function* () {
    const body = yield* Schema.decodeUnknown(ReanchorBody)({
      sharnessVersion,
      kind: "reanchor_body",
      conversationId: fixture.descriptor.conversationId,
      membershipHash: fixture.membershipHash,
      previousAnchorHash: yield* hashAnchor(anchor),
      selectedRecordHash,
      routerInstanceId: yield* Schema.decodeUnknown(RouterInstanceId)(
        `rti_${Buffer.alloc(16, 42).toString("base64url")}`,
      ),
    });
    const anchorHash = yield* hashAnchor(body);
    return yield* Schema.decodeUnknown(CompletedReanchor)({
      sharnessVersion,
      kind: "completed_reanchor",
      anchorHash,
      reanchor: body,
      certificate: {
        sharnessVersion,
        kind: "reanchor_certificate",
        anchorHash,
        votes: yield* signSet(fixture, (signerAgentId) => ({
          sharnessVersion,
          kind: "reanchor_vote",
          signerAgentId,
          anchorHash,
          reanchor: body,
        })),
      },
    });
  });
}

const generate = Effect.gen(function* () {
  const fixture = yield* deterministicFixture;
  const anchor = yield* Schema.decodeUnknown(GenesisAnchorBody)({
    sharnessVersion,
    kind: "genesis_anchor_body",
    conversationId: fixture.descriptor.conversationId,
    membershipHash: fixture.membershipHash,
    routerInstanceId: `rti_${Buffer.alloc(16, 41).toString("base64url")}`,
  });
  const previous = yield* Schema.decodeUnknown(RecordHash)(
    `rch_${Buffer.alloc(32, 50).toString("base64url")}`,
  );
  const post = yield* postForms(fixture, {
    anchor,
    previousRecordHash: previous,
    byte: 51,
    name: "N4 POST",
  });
  const completed = yield* completedAnchor(fixture, anchor, post.recordHash);
  const reanchored = yield* postForms(fixture, {
    anchor: completed,
    previousRecordHash: post.recordHash,
    byte: 52,
    name: "N4 POST completed_reanchor",
  });
  return {
    forms: [
      ...(yield* retainedForms).flat(),
      ...post.forms,
      ...reanchored.forms,
    ],
  };
});

await Effect.runPromise(
  generate.pipe(
    Effect.flatMap((golden) =>
      FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) =>
          fs.writeFileString(
            fileURLToPath(
              new URL(
                "../packages/client/src/communication/records/record-golden.json",
                import.meta.url,
              ),
            ),
            `${JSON.stringify(golden, null, 2)}\n`,
          ),
        ),
      ),
    ),
    Effect.provideService(WireVersions, {
      emitted: sharnessVersion,
      live: [sharnessVersion],
      history: [sharnessVersion],
    }),
    Effect.provide(NodeFileSystem.layer),
  ),
);
