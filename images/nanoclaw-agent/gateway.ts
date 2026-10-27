/**
 * @file Serves the NanoClaw host's CLI socket on a TCP gateway, which is how
 * the principal reaches the agent's CLI channel. Each gateway client gets a
 * socket connection of its own, piped both ways.
 */
import { createConnection, createServer, type Socket } from "node:net";

/** The TCP address the host's CLI socket is served on. */
export interface GatewayAddress {
  readonly host: string;
  readonly port: number;
}

/** A listening gateway. */
export interface Gateway {
  /** The port the gateway listens on, which the system picks for port 0. */
  readonly port: number;
  /**
   * Stop accepting clients and end every open connection. NanoClaw's
   * shutdown ends only the client that has sent a chat line, then waits for
   * every other connection to its CLI socket to end, so a principal that
   * never sent one would hold the host's shutdown until it is killed.
   */
  close(): undefined;
}

/**
 * Serve the CLI socket at `socketPath` on `address`. A client's end reaches
 * its socket connection only after everything the client wrote, so a client
 * that writes and closes at once is delivered in full, however slowly
 * NanoClaw reads.
 */
export function startGateway(
  address: GatewayAddress,
  socketPath: string,
): Promise<Gateway> {
  const open = new Set<Socket>();
  const track = (socket: Socket): void => {
    open.add(socket);
    socket.once("close", () => {
      open.delete(socket);
    });
  };
  const server = createServer((client) => {
    const native = createConnection(socketPath);
    track(client);
    track(native);
    client.pipe(native);
    native.pipe(client);
    const destroy = (): void => {
      client.destroy();
      native.destroy();
    };
    client.on("error", destroy);
    native.on("error", destroy);
  });
  const close = (): undefined => {
    server.close();
    for (const socket of open) {
      socket.destroy();
    }
  };
  return new Promise((resolveGateway, reject) => {
    server.once("error", reject);
    server.listen(address.port, address.host, () => {
      const bound = server.address();
      if (bound === null || typeof bound === "string") {
        reject(new Error("the NanoClaw gateway is not listening on TCP"));
        return;
      }
      resolveGateway({ port: bound.port, close });
    });
  });
}
