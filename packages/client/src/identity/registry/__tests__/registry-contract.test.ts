/** @file Registry configuration, private RPC, client, and server composition contract tests. */

import {
  HttpClient,
  HttpClientError,
  HttpClientResponse,
} from "@effect/platform";
import { Duration, Effect, Either, Layer, Redacted, Schema } from "effect";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AgentCardIssuedAt,
  makeVerifiedCard,
} from "../../__tests__/agent-card-fixtures.js";
import { encodeCanonicalJson } from "../../../encoding/canonical-json.js";
import {
  AgentId,
  AgentName,
  AgentSigningAuthority,
  PrincipalId,
} from "../../../index.js";
import { lookupResponseSchema, registerResponseSchema } from "../contract.js";
import { OperationId, Registry, RegistryRegisterRequest } from "../index.js";

const UNAVAILABLE_TAG = "UnavailableError";
const FOUND_KIND = "found";
const INVALID_RESPONSE_TAG = "RegistryInvalidResponseError";
const CONNECTION_ERROR_TAG = "RegistryConnectionError";
const TIMEOUT_ERROR_TAG = "RegistryRequestTimeoutError";
const SIGNING_ERROR_TAG = "AgentSigningError";
const CLIENT_ORIGIN = new URL("http://registry.example:3011");
const CLIENT_TIMEOUT = Duration.seconds(5);
const SHORT_CLIENT_TIMEOUT = Duration.millis(5);

const makePrivateKeyPem = (): string => {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ format: "pem", type: "pkcs8" });
};

const makeRequest = (name: string) =>
  Schema.decodeUnknownSync(RegistryRegisterRequest)({
    operationId: Schema.decodeUnknownSync(OperationId)(
      "opn_AAAAAAAAAAAAAAAAAAAAAA",
    ),
    principalId: Schema.decodeUnknownSync(PrincipalId)(
      "prn_AAAAAAAAAAAAAAAAAAAAAA",
    ),
    agentName: Schema.decodeUnknownSync(AgentName)(name),
    publicKey: {
      crv: "Ed25519",
      kty: "OKP",
      x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
    },
  });

const encodeResponse = <A, I>(schema: Schema.Schema<A, I>, value: A) =>
  Schema.encode(schema)(value).pipe(
    Effect.flatMap(encodeCanonicalJson),
    Effect.map((bytes) => new TextDecoder().decode(bytes)),
  );

const responseClient = (
  body: string,
  status = 200,
  contentType = "application/json",
) =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(body, {
          status,
          headers: { "content-type": contentType },
        }),
      ),
    ),
  );

const byteResponseClient = (body: Uint8Array, status: number) =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(Uint8Array.from(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  );

const runLookup = (
  client: HttpClient.HttpClient,
  registrySignerPublicKey: ReturnType<typeof AgentSigningAuthority.publicKey>,
  request: Parameters<typeof Registry.lookup>[0],
  requestTimeout?: Duration.Duration,
) =>
  Registry.lookup(request).pipe(
    Effect.provide(
      Registry.layer({
        origin: CLIENT_ORIGIN,
        registrySignerPublicKey,
        requestTimeout: requestTimeout ?? CLIENT_TIMEOUT,
      }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
    ),
    Effect.either,
  );

const outcomeName = <
  A extends { readonly kind: string },
  E extends {
    readonly _tag: string;
  },
>(
  outcome: Either.Either<A, E>,
): string =>
  Either.match(outcome, {
    onLeft: (error) => error._tag,
    onRight: (result) => result.kind,
  });

const makeClientCard = (
  registrySigningAuthority: AgentSigningAuthority,
  input: {
    readonly agentId: string;
    readonly agentName: string;
    readonly principalId?: string;
    readonly publicKey?: ReturnType<typeof AgentSigningAuthority.publicKey>;
  },
) =>
  makeVerifiedCard({
    agentId: Schema.decodeUnknownSync(AgentId)(input.agentId),
    principalId: Schema.decodeUnknownSync(PrincipalId)(
      input.principalId ?? "prn_AAAAAAAAAAAAAAAAAAAAAA",
    ),
    agentName: Schema.decodeUnknownSync(AgentName)(input.agentName),
    publicKey: input.publicKey ?? makeRequest(input.agentName).publicKey,
    issuedAt: Schema.decodeUnknownSync(AgentCardIssuedAt)(
      "2026-07-30T00:00:00Z",
    ),
    registrySigningAuthority,
  });

const makeClientFixture = Effect.gen(function* () {
  const registrySigningAuthority = yield* AgentSigningAuthority.fromPkcs8(
    Redacted.make(makePrivateKeyPem()),
  );
  const wrongRegistrySigningAuthority = yield* AgentSigningAuthority.fromPkcs8(
    Redacted.make(makePrivateKeyPem()),
  );
  const registrySignerPublicKey = AgentSigningAuthority.publicKey(
    registrySigningAuthority,
  );
  const card = yield* makeClientCard(registrySigningAuthority, {
    agentId: "agt_AAAAAAAAAAAAAAAAAAAAAA",
    agentName: "client-card",
  });
  const wrongSignerCard = yield* makeClientCard(wrongRegistrySigningAuthority, {
    agentId: card.agentId,
    agentName: card.agentName,
  });
  const [foundBody, wrongSignerBody] = yield* Effect.all(
    [
      encodeResponse(lookupResponseSchema, {
        kind: "found",
        agentCard: card,
      }),
      encodeResponse(lookupResponseSchema, {
        kind: "found",
        agentCard: wrongSignerCard,
      }),
    ] as const,
    { concurrency: 2 },
  );
  return {
    card,
    foundBody,
    registrySignerPublicKey,
    registrySigningAuthority,
    wrongSignerBody,
  };
});

type ClientFixture = Effect.Effect.Success<typeof makeClientFixture>;
type LookupScenario = Readonly<{
  name: string;
  client: (fixture: ClientFixture) => HttpClient.HttpClient;
  request: (fixture: ClientFixture) => Parameters<typeof Registry.lookup>[0];
  expected: string;
  timeout?: Duration.Duration;
}>;

const matchingLookup = (fixture: ClientFixture) => ({
  agentName: fixture.card.agentName,
});
const fixedResponse =
  (selectBody: (fixture: ClientFixture) => string, status = 200) =>
  (fixture: ClientFixture) =>
    responseClient(selectBody(fixture), status);
const lookupScenarios: readonly LookupScenario[] = [
  {
    name: "verified response card",
    client: fixedResponse((fixture) => fixture.foundBody),
    request: matchingLookup,
    expected: FOUND_KIND,
  },
  {
    name: "request binding",
    client: fixedResponse((fixture) => fixture.foundBody),
    request: () => ({
      agentName: Schema.decodeUnknownSync(AgentName)("other-card"),
    }),
    expected: INVALID_RESPONSE_TAG,
  },
  {
    name: "response-card signature",
    client: fixedResponse((fixture) => fixture.wrongSignerBody),
    request: matchingLookup,
    expected: INVALID_RESPONSE_TAG,
  },
  {
    name: "version mismatch without supported versions",
    client: fixedResponse(() => '{"error":"version_mismatch"}', 412),
    request: matchingLookup,
    expected: INVALID_RESPONSE_TAG,
  },
  {
    name: "reordered version mismatch",
    client: fixedResponse(
      () => '{"supported":["2099.101.0"],"error":"version_mismatch"}',
      412,
    ),
    request: matchingLookup,
    expected: INVALID_RESPONSE_TAG,
  },
  {
    name: "whitespace in version mismatch",
    client: fixedResponse(
      () => '{ "error":"version_mismatch","supported":["2099.101.0"]}',
      412,
    ),
    request: matchingLookup,
    expected: INVALID_RESPONSE_TAG,
  },
  {
    name: "duplicate version mismatch key",
    client: fixedResponse(
      () =>
        '{"error":"version_mismatch","error":"version_mismatch","supported":["2099.101.0"]}',
      412,
    ),
    request: matchingLookup,
    expected: INVALID_RESPONSE_TAG,
  },
  {
    name: "escaped version mismatch",
    client: fixedResponse(
      () => '{"error":"version\\u005fmismatch","supported":["2099.101.0"]}',
      412,
    ),
    request: matchingLookup,
    expected: INVALID_RESPONSE_TAG,
  },
  {
    name: "excess version mismatch member",
    client: fixedResponse(
      () =>
        '{"error":"version_mismatch","extra":true,"supported":["2099.101.0"]}',
      412,
    ),
    request: matchingLookup,
    expected: INVALID_RESPONSE_TAG,
  },
  {
    name: "invalid supported versions",
    client: fixedResponse(
      () => '{"error":"version_mismatch","supported":[1]}',
      412,
    ),
    request: matchingLookup,
    expected: INVALID_RESPONSE_TAG,
  },
  {
    name: "empty supported versions",
    client: fixedResponse(
      () => '{"error":"version_mismatch","supported":[]}',
      412,
    ),
    request: matchingLookup,
    expected: INVALID_RESPONSE_TAG,
  },
  {
    name: "invalid wire version",
    client: fixedResponse(
      () => '{"error":"version_mismatch","supported":["invalid"]}',
      412,
    ),
    request: matchingLookup,
    expected: INVALID_RESPONSE_TAG,
  },
  {
    name: "lone surrogate supported version",
    client: fixedResponse(
      () => '{"error":"version_mismatch","supported":["\\ud800"]}',
      412,
    ),
    request: matchingLookup,
    expected: INVALID_RESPONSE_TAG,
  },
  {
    name: "BOM-prefixed version mismatch",
    client: fixedResponse(
      () => '\ufeff{"error":"version_mismatch","supported":["2099.101.0"]}',
      412,
    ),
    request: matchingLookup,
    expected: INVALID_RESPONSE_TAG,
  },
  {
    name: "declared server envelope",
    client: fixedResponse(() => '{"error":"unavailable"}', 503),
    request: matchingLookup,
    expected: UNAVAILABLE_TAG,
  },
  {
    name: "BOM-prefixed server envelope",
    client: () =>
      byteResponseClient(
        Uint8Array.from([
          0xef,
          0xbb,
          0xbf,
          ...new TextEncoder().encode('{"error":"unavailable"}'),
        ]),
        503,
      ),
    request: matchingLookup,
    expected: INVALID_RESPONSE_TAG,
  },
  {
    name: "invalid response",
    client: fixedResponse(() => '{ "kind":"not_found" }'),
    request: matchingLookup,
    expected: INVALID_RESPONSE_TAG,
  },
  {
    name: "public read excludes authentication failures",
    client: fixedResponse(() => '{"error":"authentication_failed"}', 401),
    request: matchingLookup,
    expected: INVALID_RESPONSE_TAG,
  },
  {
    name: "connection failure",
    client: () =>
      HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.RequestError({
            request,
            reason: "Transport",
          }),
        ),
      ),
    request: matchingLookup,
    expected: CONNECTION_ERROR_TAG,
  },
  {
    name: "complete deadline",
    client: () => HttpClient.make(() => Effect.never),
    request: matchingLookup,
    expected: TIMEOUT_ERROR_TAG,
    timeout: SHORT_CLIENT_TIMEOUT,
  },
];

const assertLookupScenarios = (fixture: ClientFixture) =>
  Effect.forEach(
    lookupScenarios,
    (scenario) =>
      runLookup(
        scenario.client(fixture),
        fixture.registrySignerPublicKey,
        scenario.request(fixture),
        scenario.timeout,
      ).pipe(
        Effect.map((outcome) => {
          expect(outcomeName(outcome), scenario.name).toBe(scenario.expected);
          return outcome;
        }),
      ),
    { concurrency: 1, discard: true },
  );

const assertRegistrationClientBehavior = (fixture: ClientFixture) =>
  Effect.gen(function* () {
    const agentSigningAuthority = yield* AgentSigningAuthority.fromPkcs8(
      Redacted.make(makePrivateKeyPem()),
    );
    const registrationRequest = {
      ...makeRequest("registration-binding"),
      publicKey: AgentSigningAuthority.publicKey(agentSigningAuthority),
    };
    const mismatchedCard = yield* makeClientCard(
      fixture.registrySigningAuthority,
      {
        agentId: "agt_AQAAAAAAAAAAAAAAAAAAAA",
        agentName: "other-registration",
        principalId: registrationRequest.principalId,
        publicKey: registrationRequest.publicKey,
      },
    );
    const mismatchedRegistrationBody = yield* encodeResponse(
      registerResponseSchema,
      { kind: "registered", agentCard: mismatchedCard },
    );
    const registrationLayer = Registry.layer({
      origin: CLIENT_ORIGIN,
      registrySignerPublicKey: fixture.registrySignerPublicKey,
      requestTimeout: CLIENT_TIMEOUT,
    }).pipe(
      Layer.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          responseClient(mismatchedRegistrationBody),
        ),
      ),
    );
    const mismatchedRegistration = yield* Registry.register({
      request: registrationRequest,
      admissionCredential: Redacted.make("admission-token="),
      signingAuthority: agentSigningAuthority,
    }).pipe(Effect.provide(registrationLayer), Effect.either);
    expect(outcomeName(mismatchedRegistration)).toBe(INVALID_RESPONSE_TAG);

    const signingFailure = yield* Registry.register({
      request: makeRequest("signing-failure"),
      admissionCredential: Redacted.make("admission-token="),
      signingAuthority: agentSigningAuthority,
    }).pipe(Effect.provide(registrationLayer), Effect.either);
    expect(outcomeName(signingFailure)).toBe(SIGNING_ERROR_TAG);
  });

/**
 * A registered card that matches the request's name and principal but carries
 * another key is an invalid response: the card must bind the signer's key.
 */
const assertWrongKeyRegistration = (fixture: ClientFixture) =>
  Effect.gen(function* () {
    const signingAuthority = yield* AgentSigningAuthority.fromPkcs8(
      Redacted.make(makePrivateKeyPem()),
    );
    const request = {
      ...makeRequest("wrong-key"),
      publicKey: AgentSigningAuthority.publicKey(signingAuthority),
    };
    const wrongKeyCard = yield* makeClientCard(
      fixture.registrySigningAuthority,
      {
        agentId: "agt_AgAAAAAAAAAAAAAAAAAAAA",
        agentName: request.agentName,
        principalId: request.principalId,
      },
    );
    const body = yield* encodeResponse(registerResponseSchema, {
      kind: "registered",
      agentCard: wrongKeyCard,
    });
    const registryLayer = Registry.layer({
      origin: CLIENT_ORIGIN,
      registrySignerPublicKey: fixture.registrySignerPublicKey,
      requestTimeout: CLIENT_TIMEOUT,
    }).pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, responseClient(body))),
    );

    const outcome = yield* Registry.register({
      request,
      admissionCredential: Redacted.make("admission-token="),
      signingAuthority,
    }).pipe(Effect.provide(registryLayer), Effect.either);

    expect(outcomeName(outcome)).toBe(INVALID_RESPONSE_TAG);
  });

/** A Registry client whose HTTP client dies if any request is sent. */
const unsentRegistryLayer = (signingAuthority: AgentSigningAuthority) =>
  Registry.layer({
    origin: CLIENT_ORIGIN,
    registrySignerPublicKey: AgentSigningAuthority.publicKey(signingAuthority),
    requestTimeout: CLIENT_TIMEOUT,
  }).pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.dieMessage("no request is sent")),
      ),
    ),
  );

/** A request whose key throws on read fails as a signing error, not a defect. */
const assertUnreadableKeyRegistration = Effect.gen(function* () {
  const signingAuthority = yield* AgentSigningAuthority.fromPkcs8(
    Redacted.make(makePrivateKeyPem()),
  );
  const publicKey = new Proxy(
    AgentSigningAuthority.publicKey(signingAuthority),
    {
      get: () => {
        throw new Error("unreadable key");
      },
    },
  );
  const registryLayer = unsentRegistryLayer(signingAuthority);

  const outcome = yield* Registry.register({
    request: { ...makeRequest("unreadable-key"), publicKey },
    admissionCredential: Redacted.make("admission-token="),
    signingAuthority,
  }).pipe(Effect.provide(registryLayer), Effect.either);

  expect(outcomeName(outcome)).toBe(SIGNING_ERROR_TAG);
});

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

/**
 * Request records whose members throw on read fail with each entry point's
 * typed error instead of dying, and send nothing.
 */
const assertUnreadableRequestRecords = Effect.gen(function* () {
  const signingAuthority = yield* AgentSigningAuthority.fromPkcs8(
    Redacted.make(makePrivateKeyPem()),
  );
  const registryLayer = unsentRegistryLayer(signingAuthority);
  const request = makeRequest("unreadable-request");
  const [registered, lookedUp, listed] = yield* Effect.all(
    [
      Registry.register({
        request: throwingOn(
          {
            ...request,
            publicKey: AgentSigningAuthority.publicKey(signingAuthority),
          },
          "principalId",
        ),
        admissionCredential: Redacted.make("admission-token="),
        signingAuthority,
      }).pipe(Effect.either),
      Registry.lookup(
        throwingOn({ agentName: request.agentName }, "agentName"),
      ).pipe(Effect.either),
      Registry.list(
        throwingOn(
          {
            afterAgentId: Schema.decodeUnknownSync(AgentId)(
              "agt_AAAAAAAAAAAAAAAAAAAAAA",
            ),
          },
          "afterAgentId",
        ),
      ).pipe(Effect.either),
    ],
    { concurrency: 1 },
  ).pipe(Effect.provide(registryLayer));

  expect([
    outcomeName(registered),
    outcomeName(lookedUp),
    outcomeName(listed),
  ]).toStrictEqual([
    SIGNING_ERROR_TAG,
    INVALID_RESPONSE_TAG,
    INVALID_RESPONSE_TAG,
  ]);
});

const clientBehavior = Effect.gen(function* () {
  const fixture = yield* makeClientFixture;
  yield* assertLookupScenarios(fixture);
  yield* assertRegistrationClientBehavior(fixture);
  yield* assertWrongKeyRegistration(fixture);
  yield* assertUnreadableKeyRegistration;
  yield* assertUnreadableRequestRecords;
});

describe("Registry client contracts", () => {
  it("classifies public client outcomes without weakening card checks", () => {
    expect.hasAssertions();
    return Effect.runPromise(clientBehavior);
  });

  it("preserves supported versions from a canonical Registry 412", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* makeClientFixture;
        const supported = ["2099.101.0"];
        const outcome = yield* runLookup(
          responseClient(
            '{"error":"version_mismatch","supported":["2099.101.0"]}',
            412,
          ),
          fixture.registrySignerPublicKey,
          matchingLookup(fixture),
        );
        expect(outcome).toMatchObject({
          _tag: "Left",
          left: { _tag: "VersionMismatchError", supported },
        });
      }),
    ));
});
