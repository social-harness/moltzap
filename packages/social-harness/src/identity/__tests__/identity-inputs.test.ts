/** @file Identity entry points fail with their typed error when a member of their input record throws on read. */

import { HttpClient } from "@effect/platform";
import { Duration, Effect, Either, Layer, Redacted, Schema } from "effect";
import { expect, it } from "vitest";
import {
  type Group,
  makeGroup,
  messageIdOf,
  plaintext,
  sealFrom,
  signBody,
} from "../../communication/envelope/__tests__/sealed-body-fixtures.js";
import { SealedBody } from "../../communication/envelope/sealed-body.js";
import { SignedMessage } from "../../communication/envelope/signed-message.js";
import { AgentSigningAuthority } from "../keys.js";
import { OperationId } from "../registry/contract.js";
import { Registry } from "../registry/index.js";

/** A view of `value` whose `member` throws on read. */
const throwingOn = <Value extends object>(
  value: Value,
  member: string,
): Value =>
  new Proxy(value, {
    get: (target, key): unknown => {
      if (key === member) {
        throw new Error(`unreadable ${member}`);
      }
      return Reflect.get(target, key);
    },
  });

/** A Registry client whose HTTP client dies if any request is sent. */
const unsentRegistryLayer = (group: Group) =>
  Registry.layer({
    origin: new URL("http://registry.example:3011"),
    registrySignerPublicKey: AgentSigningAuthority.publicKey(
      group.registrySigningAuthority,
    ),
    requestTimeout: Duration.seconds(5),
  }).pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.dieMessage("no request is sent")),
      ),
    ),
  );

/** The tag of the entry point's failure, or `success`. */
const failureTag = (
  outcome: Either.Either<unknown, { readonly _tag: string }>,
): string =>
  Either.match(outcome, {
    onLeft: (failure) => failure._tag,
    onRight: () => "success",
  });

/** One entry point, called with an input whose `member` throws on read. */
interface EntryPointCase {
  readonly entryPoint: string;
  readonly member: string;
  readonly expected: string;
  readonly run: (
    group: Group,
    member: string,
  ) => Effect.Effect<unknown, { readonly _tag: string }>;
}

it.each<EntryPointCase>([
  {
    entryPoint: "SealedBody.seal",
    member: "recipientAgentCards",
    expected: "SealedBodySealingError",
    run: (group: Group, member: string) =>
      SealedBody.seal(
        throwingOn(
          {
            senderAgentId: group.sender.agentCard.agentId,
            recipientAgentCards: group.recipients.map((r) => r.agentCard),
            messageId: messageIdOf(1),
            plaintext,
          },
          member,
        ),
      ),
  },
  {
    entryPoint: "SealedBody.open",
    member: "signedMessage",
    expected: "SealedBodyOpeningError",
    run: (group: Group, member: string) =>
      Effect.gen(function* () {
        const sealed = yield* sealFrom(
          group.sender,
          group.recipients,
          plaintext,
        );
        const signedMessage = yield* signBody(
          group.sender,
          group.recipients,
          sealed,
        );
        return yield* SealedBody.open(
          throwingOn(
            {
              agentCard: group.peer.agentCard,
              signingAuthority: group.peer.authority,
              signedMessage,
            },
            member,
          ),
        );
      }),
  },
  {
    entryPoint: "SignedMessage.sign",
    member: "body",
    expected: "SignedMessageSigningError",
    run: (group: Group, member: string) =>
      SignedMessage.sign(
        throwingOn(
          {
            agentCard: group.sender.agentCard,
            signingAuthority: group.sender.authority,
            recipientAgentIds: new Set([group.peer.agentCard.agentId]),
            messageId: messageIdOf(1),
            body: plaintext,
          },
          member,
        ),
      ),
  },
  {
    entryPoint: "SignedMessage.verify",
    member: "agentCard",
    expected: "SignedMessageVerificationError",
    run: (group: Group, member: string) =>
      Effect.gen(function* () {
        const signedMessage = yield* signBody(
          group.sender,
          group.recipients,
          plaintext,
        );
        return yield* SignedMessage.verify(
          throwingOn(
            { signedMessage, agentCard: group.sender.agentCard },
            member,
          ),
        );
      }),
  },
  {
    entryPoint: "Registry.register",
    member: "admissionCredential",
    expected: "AgentSigningError",
    run: (group: Group, member: string) =>
      Registry.register(
        throwingOn(
          {
            request: {
              operationId: Schema.decodeUnknownSync(OperationId)(
                "opn_AAAAAAAAAAAAAAAAAAAAAA",
              ),
              principalId: group.sender.agentCard.principalId,
              agentName: group.sender.agentCard.agentName,
              publicKey: AgentSigningAuthority.publicKey(
                group.sender.authority,
              ),
            },
            admissionCredential: Redacted.make("admission-token="),
            signingAuthority: group.sender.authority,
          },
          member,
        ),
      ).pipe(Effect.provide(unsentRegistryLayer(group))),
  },
])(
  "$entryPoint fails with $expected when its input's $member throws on read",
  ({ member, expected, run }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const group = yield* makeGroup(2);

        const outcome = yield* run(group, member).pipe(Effect.either);

        expect(failureTag(outcome)).toBe(expected);
      }),
    ),
);
