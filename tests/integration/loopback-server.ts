/** @file Test-only loopback HTTP servers that stand in front of, or in place of, a real service. */

import { Effect, FiberSet, type Scope } from "effect";
import { Buffer } from "node:buffer";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { LOOPBACK_HOST, ProcessTestError } from "./daemon-process-harness.js";

/**
 * Reads one request body in full.
 * @param incoming The request to read.
 * @returns The body's bytes.
 */
export const readBody = (incoming: IncomingMessage) =>
  Effect.async<Buffer, ProcessTestError>((resume) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.once("end", () => resume(Effect.succeed(Buffer.concat(chunks))));
    incoming.once("error", (cause) =>
      resume(
        Effect.fail(
          new ProcessTestError({ message: "loopback request failed", cause }),
        ),
      ),
    );
  });

const listen = (server: Server) =>
  Effect.async<number, ProcessTestError>((resume) => {
    const onError = (cause: Error): void => {
      resume(
        Effect.fail(
          new ProcessTestError({
            message: "loopback server could not listen",
            cause,
          }),
        ),
      );
    };
    server.once("error", onError);
    server.listen(0, LOOPBACK_HOST, () => {
      server.removeListener("error", onError);
      const address = server.address();
      resume(
        address === null || typeof address === "string"
          ? Effect.fail(
              new ProcessTestError({
                message: "loopback server exposed no TCP port",
              }),
            )
          : Effect.succeed(address.port),
      );
    });
  });

const closeServer = (server: Server) =>
  Effect.async<void>((resume) => {
    server.close(() => resume(Effect.void));
    server.closeAllConnections();
  });

/**
 * Starts a loopback HTTP server on a free port that runs `handle` for each
 * request. The scope interrupts the running handlers and closes the server.
 * @param handle Answers one request.
 * @returns The listening server and its port.
 */
export const acquireLoopbackServer = (
  handle: (
    incoming: IncomingMessage,
    response: ServerResponse,
  ) => Effect.Effect<void>,
): Effect.Effect<
  { readonly server: Server; readonly port: number },
  ProcessTestError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const run = yield* FiberSet.makeRuntime<never>();
    const server = createServer((incoming, response) => {
      run(handle(incoming, response));
    });
    const port = yield* Effect.acquireRelease(listen(server), () =>
      closeServer(server),
    );
    return { server, port };
  });
