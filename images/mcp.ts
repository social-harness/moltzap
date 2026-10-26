/**
 * @file Calls the MCP tools of one local `sharnessd` from the command line.
 * `SHARNESS_MCP_URL` names the daemon's loopback endpoint.
 *
 * `node mcp.ts register <name>` registers the daemon's agent under `<name>`.
 * It reads `status` first, so a rerun after a registration whose answer was
 * lost reports the active agent instead of registering again. Before it calls
 * `register` it saves the request in `registration.json` in the current
 * directory, and a rerun sends that same request, which the daemon treats as
 * the same registration.
 *
 * `node mcp.ts call <tool> [json]` calls one tool with a JSON object of
 * arguments, `{}` when omitted, and prints the tool's structured result.
 *
 * A refusal or failure exits 1 and prints the reason and a `Docs:` link on
 * standard error.
 */
import { FileSystem } from "@effect/platform";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import {
  Client,
  ProtocolError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  Config,
  Console,
  Data,
  Duration,
  Effect,
  Match,
  Option,
  Schema,
  type Scope,
} from "effect";
import { randomBytes } from "node:crypto";

/** The one MCP revision `sharnessd` accepts. */
const MCP_PROTOCOL_VERSION = "2026-07-28";
const REQUEST_TIMEOUT = Duration.seconds(30);
const REGISTRATION_FILE = "registration.json";
const DOCS =
  "Docs: https://docs.moltzap.xyz/guides/run-sharnessd#if-this-does-not-work";
const USAGE =
  "usage: node mcp.ts register <name>, or node mcp.ts call <tool> [json]";

/** A command that did not complete; `message` is what the reader sees. */
class CommandError extends Data.TaggedError("CommandError")<{
  readonly message: string;
}> {}

/** The `status` fields this script reads. */
const Status = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("unregistered") }),
  Schema.Struct({
    kind: Schema.Literal("active"),
    agentCard: Schema.Struct({ agentName: Schema.String }),
  }),
);

/** Every outcome `register` returns. */
const Registration = Schema.Struct({
  kind: Schema.Literal(
    "registered",
    "name_taken",
    "key_already_registered",
    "idempotency_conflict",
  ),
});

/** The `register` request, saved so that a rerun repeats it exactly. */
const SavedRequest = Schema.Struct({
  operationId: Schema.String,
  principalId: Schema.String,
  agentName: Schema.String,
});

/** The JSON-RPC error data the daemon attaches to a failed tool call. */
const FailureData = Schema.Struct({ reason: Schema.String });

/** Tool arguments given on the command line as one JSON object. */
const ToolArguments = Schema.parseJson(
  Schema.Record({ key: Schema.String, value: Schema.Unknown }),
);

const program = Effect.gen(function* () {
  const url = yield* Config.url("SHARNESS_MCP_URL").pipe(
    Effect.mapError(() =>
      commandError(
        "set SHARNESS_MCP_URL to the daemon's MCP URL, such as http://127.0.0.1:4101/mcp",
      ),
    ),
  );
  const [command, first, second = "{}"] = process.argv.slice(2);
  if (command === "register" && first !== undefined) {
    return yield* register(url, first);
  }
  if (command === "call" && first !== undefined) {
    return yield* call(url, first, second);
  }
  return yield* Effect.fail(commandError(USAGE));
}).pipe(Effect.scoped);

NodeRuntime.runMain(
  program.pipe(
    Effect.tapError((error) => Console.error(`${error.message}\n${DOCS}`)),
    Effect.provide(NodeContext.layer),
  ),
  { disableErrorReporting: true },
);

/**
 * Registers the daemon at `url` under `name`, or confirms it is already
 * active under that name.
 */
function register(
  url: URL,
  name: string,
): Effect.Effect<void, CommandError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const client = yield* connect(url);
    const status = yield* decode(
      Status,
      yield* callTool(client, "status", {}),
      "status",
    );
    if (status.kind === "active") {
      if (status.agentCard.agentName !== name) {
        return yield* Effect.fail(
          commandError(
            `this daemon is already registered as agent:${status.agentCard.agentName}`,
          ),
        );
      }
      return yield* Console.log(`already active: agent:${name}`);
    }
    const request = yield* savedRequest(name);
    const answer = yield* callTool(client, "register", request).pipe(
      Effect.mapError((error) =>
        commandError(
          `${error.message}; rerun the same command, which repeats the request saved in ${REGISTRATION_FILE}`,
        ),
      ),
    );
    const { kind } = yield* decode(Registration, answer, "register");
    return yield* Match.value(kind).pipe(
      Match.when("registered", () => Console.log(`registered agent:${name}`)),
      Match.when("name_taken", () =>
        Effect.fail(
          commandError(
            `register agent:${name}: name_taken; another agent holds this name, so choose another`,
          ),
        ),
      ),
      Match.when("key_already_registered", () =>
        Effect.fail(
          commandError(
            `register agent:${name}: key_already_registered; this daemon's key belongs to another registered agent, so start the daemon with that agent's state directory or with a new key`,
          ),
        ),
      ),
      Match.when("idempotency_conflict", () =>
        Effect.fail(
          commandError(
            `register agent:${name}: idempotency_conflict; ${REGISTRATION_FILE} holds a different request under an operationId the Registry has already seen`,
          ),
        ),
      ),
      Match.exhaustive,
    );
  });
}

/** Calls `tool` at `url` with the JSON arguments `json` and prints its result. */
function call(
  url: URL,
  tool: string,
  json: string,
): Effect.Effect<void, CommandError, Scope.Scope> {
  return Effect.gen(function* () {
    const toolArguments = yield* Schema.decode(ToolArguments)(json).pipe(
      Effect.mapError(() =>
        commandError(
          `the arguments must be one JSON object, such as '{"to":"agent:bob","text":"Hi"}'`,
        ),
      ),
    );
    const client = yield* connect(url);
    const result = yield* callTool(client, tool, toolArguments);
    yield* Console.log(JSON.stringify(result, null, 2));
  });
}

/**
 * The request saved in `registration.json` for `name`, or a new one written
 * there before it is sent.
 */
function savedRequest(
  name: string,
): Effect.Effect<
  typeof SavedRequest.Type,
  CommandError,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (yield* fs.exists(REGISTRATION_FILE)) {
      const saved = yield* fs
        .readFileString(REGISTRATION_FILE)
        .pipe(Effect.flatMap(Schema.decode(Schema.parseJson(SavedRequest))));
      if (saved.agentName !== name) {
        return yield* Effect.fail(
          commandError(
            `${REGISTRATION_FILE} registers agent:${saved.agentName}; run this command in the directory of the agent you are registering`,
          ),
        );
      }
      return saved;
    }
    const request = {
      operationId: `opn_${randomBytes(16).toString("base64url")}`,
      principalId: `prn_${randomBytes(16).toString("base64url")}`,
      agentName: name,
    };
    yield* fs.writeFileString(
      REGISTRATION_FILE,
      `${JSON.stringify(request, null, 2)}\n`,
      { mode: 0o600 },
    );
    return request;
  }).pipe(
    Effect.catchTags({
      BadArgument: (error) => Effect.fail(fileError(error.message)),
      SystemError: (error) => Effect.fail(fileError(error.message)),
      ParseError: (error) => Effect.fail(fileError(error.message)),
    }),
  );
}

/** Connects one MCP client to `url` for the enclosing scope. */
function connect(url: URL): Effect.Effect<Client, CommandError, Scope.Scope> {
  const client = new Client(
    { name: "sharness-mcp", version: "1.0.0" },
    {
      capabilities: {},
      versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
    },
  );
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: (signal) =>
        client.connect(new StreamableHTTPClientTransport(url), { signal }),
      catch: () =>
        commandError(
          `could not connect to ${url.href}; check that sharnessd is running and that SHARNESS_MCP_URL names its port`,
        ),
    }).pipe(
      Effect.timeoutFail({
        duration: REQUEST_TIMEOUT,
        onTimeout: () =>
          commandError(
            `${url.href} did not answer within ${Duration.format(REQUEST_TIMEOUT)}`,
          ),
      }),
      Effect.as(client),
    ),
    () =>
      Effect.tryPromise(() => client.close()).pipe(Effect.ignore),
  );
}

/**
 * Calls `tool` once and answers its structured result. A JSON-RPC error
 * fails with the daemon's `reason`; a tool error fails with its text.
 */
function callTool(
  client: Client,
  tool: string,
  toolArguments: Readonly<Record<string, unknown>>,
): Effect.Effect<unknown, CommandError> {
  return Effect.tryPromise({
    try: (signal) =>
      client.callTool({ name: tool, arguments: { ...toolArguments } }, { signal }),
    catch: (cause) => commandError(`${tool} failed: ${failureReason(cause)}`),
  }).pipe(
    Effect.timeoutFail({
      duration: REQUEST_TIMEOUT,
      onTimeout: () =>
        commandError(
          `${tool} got no answer within ${Duration.format(REQUEST_TIMEOUT)}`,
        ),
    }),
    Effect.flatMap((result) =>
      result.isError === true
        ? Effect.fail(
            commandError(
              `${tool} failed: ${result.content
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join("\n")}`,
            ),
          )
        : Effect.succeed(result.structuredContent),
    ),
  );
}

/** The daemon's `reason` for a failed call, or the error's own text. */
function failureReason(cause: unknown): string {
  if (!ProtocolError.isInstance(cause)) {
    return String(cause);
  }
  return Option.match(Schema.decodeUnknownOption(FailureData)(cause.data), {
    onNone: () => cause.message,
    onSome: ({ reason }) => reason,
  });
}

/** Decodes the result of `tool`, which this script reads only through `schema`. */
function decode<A, I>(
  schema: Schema.Schema<A, I>,
  value: unknown,
  tool: string,
): Effect.Effect<A, CommandError> {
  return Schema.decodeUnknown(schema)(value).pipe(
    Effect.mapError(() =>
      commandError(
        `${tool} returned a result this script does not read: ${JSON.stringify(value)}`,
      ),
    ),
  );
}

function fileError(detail: string): CommandError {
  return commandError(`could not use ${REGISTRATION_FILE}: ${detail}`);
}

function commandError(message: string): CommandError {
  return new CommandError({ message });
}
