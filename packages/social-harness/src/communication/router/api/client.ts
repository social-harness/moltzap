/** @file Public Router capability and its authenticated HTTP implementation. */
import {
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "@effect/platform";
import { Context, Duration, Effect, Layer, Option, Schema } from "effect";
import type { AgentId } from "../../../identity/identifiers.js";
import type { AgentSigningAuthority } from "../../../identity/keys.js";
import {
  AgentSigningError,
  AuthenticatedHttp,
} from "../../../identity/index.js";
import {
  isCanonicalRouterJson,
  type RouterClientError,
  RouterConnectionError,
  type RouterHttpEnvelopeError,
  routerHttpErrorFromResponse,
  RouterInvalidResponseError,
  routerJsonContentType,
  routerPollPath,
  RouterPollRequest,
  RouterPollResult,
  RouterRequestTimeoutError,
  routerSendPath,
  RouterSendRequest,
  RouterSendResult,
} from "./contract.js";

/** @inline */
interface RouterClientService {
  readonly send: (input: {
    readonly request: RouterSendRequest;
    readonly callerAgentId: AgentId;
    readonly signingAuthority: AgentSigningAuthority;
  }) => Effect.Effect<RouterSendResult, RouterClientError>;
  readonly poll: (input: {
    readonly request: RouterPollRequest;
    readonly callerAgentId: AgentId;
    readonly signingAuthority: AgentSigningAuthority;
  }) => Effect.Effect<RouterPollResult, RouterClientError>;
}

interface RouterClientSettings {
  readonly origin: URL;
  readonly sendTimeout: Duration.Duration;
  readonly pollTimeout: Duration.Duration;
}

/**
 * Sends attributed messages and polls one agent's share of the Router feed.
 *
 * Each call authenticates with the supplied agent's signing authority. Router
 * acceptance establishes volatile retention, while recipients verify messages
 * and endpoints establish durable conversation history. See the
 * [Router contract](https://github.com/social-harness/moltzap/blob/main/docs/reference/spec/communication/router.md).
 */
export class Router extends Context.Tag("@moltzap/social-harness/Router")<
  Router,
  RouterClientService
>() {
  /**
   * Sends under the last observed Router instance. `initial` appends a new
   * retained identity; `retry` checks the exact previously sent bytes without
   * appending. The authenticated caller must be the message's sender.
   *
   * An `accepted` result proves neither delivery nor durable storage. A
   * transport failure may leave acceptance unknown, so retry the same message
   * rather than signing another one.
   */
  static readonly send: (input: {
    readonly request: RouterSendRequest;
    readonly callerAgentId: AgentId;
    readonly signingAuthority: AgentSigningAuthority;
  }) => Effect.Effect<RouterSendResult, RouterClientError, Router> =
    Effect.serviceFunctionEffect(Router, (service) => service.send);

  /**
   * Omitting the cursor returns an immediate empty batch at the current tail.
   * A continuation returns addressed messages in Router order or waits for the
   * fixed poll deadline. Results contain parsed, unverified messages. Verify
   * the entire batch and durably accept its inputs before advancing the cursor.
   *
   * `feed_gap` requires endpoint history recovery. `cursor_invalid` supplies no
   * replacement instance; obtain a new omitted-cursor anchor for recovery.
   */
  static readonly poll: (input: {
    readonly request: RouterPollRequest;
    readonly callerAgentId: AgentId;
    readonly signingAuthority: AgentSigningAuthority;
  }) => Effect.Effect<RouterPollResult, RouterClientError, Router> =
    Effect.serviceFunctionEffect(Router, (service) => service.poll);

  /**
   * Snapshots the origin and durations when constructed. Each timeout covers
   * the complete authenticated call, including response decoding. The caller
   * supplies the HTTP transport and owns retry and recovery policy.
   */
  static readonly layer = (input: {
    readonly origin: URL;
    readonly sendTimeout: Duration.Duration;
    readonly pollTimeout: Duration.Duration;
  }): Layer.Layer<Router, never, HttpClient.HttpClient> =>
    Layer.effect(Router, makeRouterClient(input));
}

function makeRouterClient(input: {
  readonly origin: URL;
  readonly sendTimeout: Duration.Duration;
  readonly pollTimeout: Duration.Duration;
}): Effect.Effect<RouterClientService, never, HttpClient.HttpClient> {
  const settings = Object.freeze({
    origin: new URL(input.origin.href),
    sendTimeout: snapshotDuration(input.sendTimeout),
    pollTimeout: snapshotDuration(input.pollTimeout),
  });
  return HttpClient.HttpClient.pipe(
    Effect.map((client) => makeClientService(client, settings)),
    Effect.withSpan("makeRouterClient"),
  );
}

const invalidResponse = () => new RouterInvalidResponseError();
const utf8Decoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});
const decodeUtf8 = (
  bytes: Uint8Array,
): Effect.Effect<string, RouterInvalidResponseError> =>
  Effect.try({
    try: () => utf8Decoder.decode(bytes),
    catch: invalidResponse,
  });

const decodeCanonicalResult = <A, I>(
  schema: Schema.Schema<A, I>,
  bytes: Uint8Array,
): Effect.Effect<A, RouterInvalidResponseError> =>
  Effect.gen(function* () {
    const text = yield* decodeUtf8(bytes);
    const result = yield* Schema.decodeUnknown(Schema.parseJson(schema))(text, {
      exact: true,
      onExcessProperty: "error",
    }).pipe(Effect.mapError(invalidResponse));
    const encoded = yield* Schema.encode(schema)(result).pipe(
      Effect.mapError(invalidResponse),
    );
    if (!isCanonicalRouterJson(text, encoded)) {
      return yield* Effect.fail(invalidResponse());
    }
    return result;
  });

/**
 * Gateway statuses an intermediary answers with while the Router behind it is
 * down or restarting.
 */
const gatewayStatuses: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * Whether a response is a gateway's page rather than a Router answer: a
 * gateway status without the Router's JSON content type. The Router itself
 * could not be reached, so this is a connection failure, not an invalid
 * Router response.
 */
const isGatewayPage = (
  response: HttpClientResponse.HttpClientResponse,
): boolean =>
  gatewayStatuses.has(response.status) &&
  response.headers["content-type"] !== routerJsonContentType;

const decodeResponse = <A, I>(
  schema: Schema.Schema<A, I>,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<
  A,
  RouterHttpEnvelopeError | RouterConnectionError | RouterInvalidResponseError
> =>
  Effect.gen(function* () {
    if (isGatewayPage(response)) {
      return yield* Effect.fail(new RouterConnectionError());
    }
    const bytes = yield* response.arrayBuffer.pipe(
      Effect.catchTag("ResponseError", () =>
        Effect.fail(new RouterConnectionError()),
      ),
      Effect.map((buffer) => new Uint8Array(buffer)),
    );
    if (response.headers["content-type"] !== routerJsonContentType) {
      return yield* Effect.fail(invalidResponse());
    }
    if (response.status === 200) {
      return yield* decodeCanonicalResult(schema, bytes);
    }
    const text = yield* decodeUtf8(bytes);
    const recognized = routerHttpErrorFromResponse(response.status, text);
    if (Option.isNone(recognized)) {
      return yield* Effect.fail(invalidResponse());
    }
    return yield* Effect.fail(recognized.value);
  });

const execute = <Request, RequestEncoded, A, I>(input: {
  readonly client: HttpClient.HttpClient;
  readonly origin: URL;
  readonly path: string;
  readonly request: Request;
  readonly requestSchema: Schema.Schema<Request, RequestEncoded>;
  readonly schema: Schema.Schema<A, I>;
  readonly callerAgentId: AgentId;
  readonly signingAuthority: AgentSigningAuthority;
  readonly timeout: Duration.Duration;
}): Effect.Effect<A, RouterClientError> =>
  Effect.gen(function* () {
    const request = HttpClientRequest.post(new URL(input.path, input.origin));
    const encodedRequest = yield* Schema.encode(input.requestSchema)(
      input.request,
    ).pipe(
      Effect.catchTag("ParseError", () => Effect.fail(new AgentSigningError())),
    );
    const signedRequest = yield* AuthenticatedHttp.signAgentRequest({
      httpRequest: request,
      callerAgentId: input.callerAgentId,
      encodedRequest,
      signingAuthority: input.signingAuthority,
    });
    const response = yield* input.client.execute(signedRequest).pipe(
      Effect.catchTags({
        RequestError: () => Effect.fail(new RouterConnectionError()),
        ResponseError: () => Effect.fail(new RouterConnectionError()),
      }),
    );
    return yield* decodeResponse(input.schema, response);
  }).pipe(
    Effect.timeoutFail({
      duration: input.timeout,
      onTimeout: () => new RouterRequestTimeoutError(),
    }),
  );

function snapshotDuration(duration: Duration.Duration): Duration.Duration {
  return Duration.match(duration, {
    onMillis: Duration.millis,
    onNanos: Duration.nanos,
  });
}

function makeClientService(
  client: HttpClient.HttpClient,
  settings: RouterClientSettings,
): RouterClientService {
  return {
    send: (call) =>
      execute({
        client,
        origin: settings.origin,
        path: routerSendPath,
        request: call.request,
        requestSchema: RouterSendRequest,
        schema: RouterSendResult,
        callerAgentId: call.callerAgentId,
        signingAuthority: call.signingAuthority,
        timeout: settings.sendTimeout,
      }),
    poll: (call) =>
      execute({
        client,
        origin: settings.origin,
        path: routerPollPath,
        request: call.request,
        requestSchema: RouterPollRequest,
        schema: RouterPollResult,
        callerAgentId: call.callerAgentId,
        signingAuthority: call.signingAuthority,
        timeout: settings.pollTimeout,
      }),
  };
}
