/** @file Authenticated Router HTTP routes and exact envelope projection. */
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import { NodeHttpServerRequest } from "@effect/platform-node";
import {
  AuthenticatedHttp,
  InternalServerError,
  MalformedRequestError,
  MethodNotAllowedError,
  OverloadedError,
  PayloadTooLargeError,
  RouteNotFoundError,
  UnsupportedMediaTypeError,
} from "@moltzap/client";
import { RouterApi } from "@moltzap/client/internal";
import canonicalize from "canonicalize";
import { Cause, Effect, Option, Schema } from "effect";
import type { RouterFeed } from "./feed.js";
import { type RouterRpcClient, withVerifiedRouterRequest } from "./rpc.js";

interface RouterHttpInput {
  readonly client: RouterRpcClient;
  readonly feed: RouterFeed;
  readonly requestSemaphore: Effect.Semaphore;
}

/**
 * Builds the complete Router HTTP application over private capabilities.
 *
 * @param input Correlated operations, readiness, and admission capability.
 * @param input.client Private correlated operations.
 * @param input.feed Feed readiness state.
 * @param input.requestSemaphore Immediate active-request admission.
 * @returns The complete named-route HTTP application.
 */
export const makeRouterHttpApp = (input: RouterHttpInput) =>
  HttpRouter.empty.pipe(
    sendRoute(input),
    pollRoute(input),
    healthRoute(input),
    fallbackRoute(),
  );

/**
 * Reports local readiness without exposing feed state.
 *
 * @param feed Current process feed.
 * @returns An empty 204 or 503 response.
 */
export const routerHealthResponse = (
  feed: RouterFeed,
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  feed.freshAppendReady.pipe(
    Effect.map((ready) =>
      HttpServerResponse.empty({ status: ready ? 204 : 503 }),
    ),
  );

const rawPollRequest = Schema.Struct({
  pollCursor: Schema.optional(
    Schema.String.pipe(Schema.maxLength(RouterApi.maximumPollCursorLength)),
  ),
}).annotations({
  parseOptions: { exact: true, onExcessProperty: "error" },
});

const jsonText = (body: string, status: number) =>
  HttpServerResponse.text(body, {
    status,
    contentType: RouterApi.routerJsonContentType,
  });

const errorResponse = (error: { readonly _tag: string }) => {
  const mapped = RouterApi.routerHttpErrorEnvelope(error._tag);
  return mapped === undefined
    ? jsonText('{"error":"internal"}', 500)
    : jsonText(mapped.body, mapped.status);
};

const recoverUnexpectedFailure = <E, R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> =>
  effect.pipe(
    Effect.catchAllCause((cause) =>
      Effect.logError("Router route failed", Cause.squash(cause)).pipe(
        Effect.as(errorResponse(new InternalServerError())),
      ),
    ),
  );

const resultResponse = <A, I>(
  schema: Schema.Schema<A, I>,
  value: A,
): Effect.Effect<HttpServerResponse.HttpServerResponse, InternalServerError> =>
  Schema.encode(schema)(value).pipe(
    Effect.catchTag("ParseError", () => Effect.fail(new InternalServerError())),
    Effect.flatMap((encoded) => {
      const body = canonicalize(encoded);
      return body === undefined
        ? Effect.fail(new InternalServerError())
        : Effect.succeed(jsonText(body, 200));
    }),
  );

const canonicalContentLength = (
  request: HttpServerRequest.HttpServerRequest,
): number | undefined => {
  const value = request.headers["content-length"];
  if (value === undefined || !/^(?:0|[1-9]\d*)$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const rawHeaderCount = (
  request: HttpServerRequest.HttpServerRequest,
  name: string,
): number => {
  const incomingMessage = NodeHttpServerRequest.toIncomingMessage(request);
  let count = 0;
  for (let index = 0; index < incomingMessage.rawHeaders.length; index += 2) {
    if (incomingMessage.rawHeaders[index]?.toLowerCase() === name) {
      count += 1;
    }
  }
  return count;
};

const SINGLE_VALUE_HEADERS = [
  "host",
  "content-type",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "sharness-version",
  "content-digest",
  "signature-input",
  "signature",
] as const;

const framingIsMalformed = (
  request: HttpServerRequest.HttpServerRequest,
): boolean => {
  const duplicate = SINGLE_VALUE_HEADERS.some(
    (name) => rawHeaderCount(request, name) > 1,
  );
  const conflictingLength =
    request.headers["content-length"] !== undefined &&
    request.headers["transfer-encoding"] !== undefined;
  return duplicate || conflictingLength;
};

const mediaTypeIsUnsupported = (
  request: HttpServerRequest.HttpServerRequest,
): boolean =>
  request.headers["content-type"] !== RouterApi.routerJsonContentType ||
  request.headers["content-encoding"] !== undefined;

const validateDeclaredLength = (
  request: HttpServerRequest.HttpServerRequest,
  maximumBytes: number,
): Effect.Effect<void, MalformedRequestError | PayloadTooLargeError> => {
  const headerIsPresent = request.headers["content-length"] !== undefined;
  const declaredLength = canonicalContentLength(request);
  if (headerIsPresent && declaredLength === undefined) {
    return Effect.fail(new MalformedRequestError());
  }
  if (declaredLength !== undefined && declaredLength > maximumBytes) {
    return Effect.fail(new PayloadTooLargeError());
  }
  return Effect.void;
};

const validateRequestFraming = (
  request: HttpServerRequest.HttpServerRequest,
  maximumBytes: number,
): Effect.Effect<
  void,
  PayloadTooLargeError | MalformedRequestError | UnsupportedMediaTypeError
> => {
  if (framingIsMalformed(request)) {
    return Effect.fail(new MalformedRequestError());
  }
  if (mediaTypeIsUnsupported(request)) {
    return Effect.fail(new UnsupportedMediaTypeError());
  }
  return validateDeclaredLength(request, maximumBytes);
};

const readBoundedBody = (
  request: HttpServerRequest.HttpServerRequest,
  maximumBytes: number,
): Effect.Effect<Uint8Array, PayloadTooLargeError | MalformedRequestError> =>
  // #ignore-sloppy-code-next-line[async-keyword]: This Effect callback constructor does not use the JavaScript keyword.
  Effect.async((resume) => {
    const incoming = NodeHttpServerRequest.toIncomingMessage(request);
    const body = new Uint8Array(maximumBytes);
    let length = 0;
    function cleanup() {
      incoming.off("data", onData);
      incoming.off("end", onEnd);
      incoming.off("error", onError);
    }
    function onData(chunk: Uint8Array) {
      if (length + chunk.byteLength > maximumBytes) {
        cleanup();
        incoming.resume();
        resume(Effect.fail(new PayloadTooLargeError()));
        return;
      }
      body.set(chunk, length);
      length += chunk.byteLength;
    }
    function onEnd() {
      cleanup();
      resume(Effect.succeed(body.slice(0, length)));
    }
    function onError() {
      cleanup();
      resume(Effect.fail(new MalformedRequestError()));
    }
    incoming.on("data", onData);
    incoming.once("end", onEnd);
    incoming.once("error", onError);
    return Effect.sync(() => {
      cleanup();
      incoming.resume();
    });
  });

interface DomainRequestInput<Request, RequestEncoded, Result, ResultEncoded> {
  readonly routePath: string;
  readonly outerRequestSchema: Schema.Schema<Request, RequestEncoded>;
  readonly resultSchema: Schema.Schema<Result, ResultEncoded>;
  readonly bodyCap: number;
  readonly invoke: (
    client: RouterRpcClient,
    request: Request,
  ) => Effect.Effect<Result, { readonly _tag: string }>;
  readonly client: RouterRpcClient;
  readonly requestSemaphore: Effect.Semaphore;
}

const runAdmittedDomainRequest = <
  Request,
  RequestEncoded,
  Result,
  ResultEncoded,
>(
  input: DomainRequestInput<Request, RequestEncoded, Result, ResultEncoded>,
  httpRequest: HttpServerRequest.HttpServerRequest,
) =>
  Effect.gen(function* () {
    const bodyBytes = yield* readBoundedBody(httpRequest, input.bodyCap);
    const verifiedRequest = yield* AuthenticatedHttp.verifyAgentRequest({
      httpRequest,
      bodyBytes,
    });
    const request = yield* Schema.decodeUnknown(input.outerRequestSchema)(
      verifiedRequest.request,
      {
        exact: true,
        onExcessProperty: "error",
      },
    ).pipe(
      Effect.catchTag("ParseError", () =>
        Effect.fail(new MalformedRequestError()),
      ),
    );
    const result = yield* withVerifiedRouterRequest(
      verifiedRequest,
      input.invoke(input.client, request),
    );
    return yield* resultResponse(input.resultSchema, result);
  });

const handleDomainRequest = <Request, RequestEncoded, Result, ResultEncoded>(
  input: DomainRequestInput<Request, RequestEncoded, Result, ResultEncoded>,
) =>
  Effect.gen(function* () {
    const httpRequest = yield* HttpServerRequest.HttpServerRequest;
    if (httpRequest.url !== input.routePath) {
      return errorResponse(new RouteNotFoundError());
    }
    yield* validateRequestFraming(httpRequest, input.bodyCap);
    const admitted = yield* input.requestSemaphore.withPermitsIfAvailable(1)(
      runAdmittedDomainRequest(input, httpRequest),
    );
    return yield* Option.match(admitted, {
      onNone: () => Effect.succeed(errorResponse(new OverloadedError())),
      onSome: Effect.succeed,
    });
  }).pipe(
    Effect.catchAll((error) => Effect.succeed(errorResponse(error))),
    recoverUnexpectedFailure,
  );

function sendRoute(input: RouterHttpInput) {
  return HttpRouter.post(
    RouterApi.routerSendRoutePattern,
    handleDomainRequest({
      routePath: RouterApi.routerSendPath,
      outerRequestSchema: RouterApi.RawRouterSendRequest,
      resultSchema: RouterApi.RouterSendResult,
      bodyCap: RouterApi.routerRepresentationLimits.sendRequestBodyBytes,
      invoke: (client, request) => client.send({ request }),
      client: input.client,
      requestSemaphore: input.requestSemaphore,
    }),
  );
}

function pollRoute(input: RouterHttpInput) {
  return HttpRouter.post(
    RouterApi.routerPollRoutePattern,
    handleDomainRequest({
      routePath: RouterApi.routerPollPath,
      outerRequestSchema: rawPollRequest,
      resultSchema: RouterApi.RouterPollResult,
      bodyCap: RouterApi.routerRepresentationLimits.pollRequestBodyBytes,
      invoke: (client, request) =>
        Schema.decodeUnknown(RouterApi.RouterPollRequest)(request, {
          exact: true,
          onExcessProperty: "error",
        }).pipe(
          Effect.matchEffect({
            onFailure: () =>
              Effect.succeed({ kind: "cursor_invalid" } as const),
            onSuccess: (decoded) => client.poll({ request: decoded }),
          }),
        ),
      client: input.client,
      requestSemaphore: input.requestSemaphore,
    }),
  );
}

function healthRoute(input: RouterHttpInput) {
  return HttpRouter.get(
    RouterApi.routerHealthPath,
    recoverUnexpectedFailure(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.url !== RouterApi.routerHealthPath) {
          return errorResponse(new RouteNotFoundError());
        }
        return yield* routerHealthResponse(input.feed);
      }),
    ),
  );
}

function fallbackRoute() {
  return HttpRouter.all(
    "*",
    recoverUnexpectedFailure(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.url.includes("?")) {
          return errorResponse(new RouteNotFoundError());
        }
        const path = request.url.split("?", 1)[0];
        if (
          path === RouterApi.routerSendPath ||
          path === RouterApi.routerPollPath ||
          path === RouterApi.routerHealthPath
        ) {
          return errorResponse(new MethodNotAllowedError());
        }
        return errorResponse(new RouteNotFoundError());
      }),
    ),
  );
}
