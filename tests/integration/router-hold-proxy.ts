/** @file Test-only Router proxy that parks delivery-bearing poll responses. */

import { Deferred, Effect, Option, Ref, Schema, type Scope } from "effect";
import { Buffer } from "node:buffer";
import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  request as requestHttp,
  type ServerResponse,
} from "node:http";
import { LOOPBACK_HOST, ProcessTestError } from "./daemon-process-harness.js";
import { acquireLoopbackServer, readBody } from "./loopback-server.js";

const ROUTER_POLL_PATH = "/v1/messages:poll";
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "trailer",
  "upgrade",
] as const;

/**
 * A poll batch the Router has already ordered for the polling endpoint. Only
 * the fields that decide parking are read; the forwarded bytes stay verbatim.
 */
const deliveryBatch = Schema.parseJson(
  Schema.Struct({
    kind: Schema.Literal("batch"),
    signedMessages: Schema.NonEmptyArray(Schema.Unknown),
  }),
);

/** Scoped control over one endpoint's Router link. */
export interface RouterHoldProxy {
  /** Origin the held endpoint daemon uses as its Router. */
  readonly origin: URL;
  /** Parks every later delivery-bearing poll response until `release`. */
  readonly hold: Effect.Effect<void>;
  /** Writes every parked response verbatim and stops parking. */
  readonly release: Effect.Effect<void>;
  /** Count of delivery-bearing poll responses parked since acquisition. */
  readonly parkedResponses: Effect.Effect<number>;
}

interface UpstreamResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

interface HoldState {
  readonly gate: Option.Option<Deferred.Deferred<void>>;
  readonly parkedResponses: number;
}

const withoutHopByHop = (headers: IncomingHttpHeaders): IncomingHttpHeaders => {
  const copied = { ...headers };
  for (const name of HOP_BY_HOP_HEADERS) {
    delete copied[name];
  }
  return copied;
};

/**
 * Forwards one request byte-for-byte, keeping the endpoint's Host header
 * because the Router verifies it as the signed `@authority`.
 */
const forward = (upstream: URL, incoming: IncomingMessage, body: Buffer) =>
  Effect.async<UpstreamResponse, ProcessTestError>((resume) => {
    const outgoing = requestHttp(
      {
        hostname: upstream.hostname,
        port: upstream.port,
        method: incoming.method,
        path: incoming.url,
        headers: {
          ...withoutHopByHop(incoming.headers),
          "content-length": String(body.byteLength),
          connection: "close",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        const fail = (cause?: unknown): void => {
          resume(
            Effect.fail(
              new ProcessTestError({
                message: "proxy upstream response failed",
                cause,
              }),
            ),
          );
        };
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("error", fail);
        response.once("aborted", () => fail());
        response.once("end", () =>
          resume(
            Effect.succeed({
              status: response.statusCode ?? 502,
              headers: response.headers,
              body: Buffer.concat(chunks),
            }),
          ),
        );
      },
    );
    outgoing.once("error", (cause) =>
      resume(
        Effect.fail(
          new ProcessTestError({ message: "proxy upstream failed", cause }),
        ),
      ),
    );
    outgoing.end(body);
    return Effect.sync(() => {
      outgoing.destroy();
    });
  });

const carriesDeliveries = (
  incoming: IncomingMessage,
  upstream: UpstreamResponse,
): boolean =>
  incoming.method === "POST" &&
  incoming.url === ROUTER_POLL_PATH &&
  upstream.status === 200 &&
  Option.isSome(
    Schema.decodeUnknownOption(deliveryBatch)(upstream.body.toString("utf8")),
  );

const parkIfHeld = (state: Ref.Ref<HoldState>): Effect.Effect<void> =>
  Ref.modify(state, (current): readonly [HoldState["gate"], HoldState] =>
    Option.isSome(current.gate)
      ? [
          current.gate,
          { ...current, parkedResponses: current.parkedResponses + 1 },
        ]
      : [Option.none(), current],
  ).pipe(
    Effect.flatMap((gate) =>
      Option.isSome(gate) ? Deferred.await(gate.value) : Effect.void,
    ),
  );

const writeResponse = (
  response: ServerResponse,
  upstream: UpstreamResponse,
): void => {
  if (response.destroyed) {
    return;
  }
  response.writeHead(upstream.status, {
    ...withoutHopByHop(upstream.headers),
    "content-length": String(upstream.body.byteLength),
  });
  response.end(upstream.body);
};

const failResponse = (response: ServerResponse): void => {
  if (response.destroyed) {
    return;
  }
  if (!response.headersSent) {
    response.writeHead(502, { "content-length": "0" });
  }
  response.end();
};

const handle = (
  upstream: URL,
  state: Ref.Ref<HoldState>,
  incoming: IncomingMessage,
  response: ServerResponse,
) =>
  Effect.gen(function* () {
    const body = yield* readBody(incoming);
    const answer = yield* forward(upstream, incoming, body);
    if (carriesDeliveries(incoming, answer)) {
      yield* parkIfHeld(state);
    }
    writeResponse(response, answer);
  }).pipe(
    Effect.tapErrorCause((cause) =>
      Effect.logWarning("router hold proxy answered 502", cause),
    ),
    Effect.catchAll(() => Effect.sync(() => failResponse(response))),
  );

/**
 * Starts a loopback reverse proxy in front of the real Router. Responses are
 * parked only after the Router has answered, so a parked poll proves the
 * message is already ordered and awaiting delivery. Handlers are interrupted
 * and the listener is closed when the scope ends.
 */
export const acquireRouterHoldProxy = (
  upstream: URL,
): Effect.Effect<RouterHoldProxy, ProcessTestError, Scope.Scope> =>
  Effect.gen(function* () {
    const state = yield* Ref.make<HoldState>({
      gate: Option.none(),
      parkedResponses: 0,
    });
    const { port } = yield* acquireLoopbackServer((incoming, response) =>
      handle(upstream, state, incoming, response),
    );
    const hold = Deferred.make<void>().pipe(
      Effect.flatMap((gate) =>
        Ref.update(state, (current) => ({
          ...current,
          gate: Option.some(gate),
        })),
      ),
    );
    const release = Ref.modify(state, (current) => [
      current.gate,
      { ...current, gate: Option.none() },
    ]).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (gate) => Deferred.succeed(gate, undefined),
        }),
      ),
      Effect.asVoid,
    );
    return {
      origin: new URL(`http://${LOOPBACK_HOST}:${port}`),
      hold,
      release,
      parkedResponses: Ref.get(state).pipe(
        Effect.map(({ parkedResponses }) => parkedResponses),
      ),
    };
  });
