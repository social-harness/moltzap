/** @file Durable Registry persistence for admission, immutable cards, and idempotent operations. */

import type { SqlError } from "@effect/sql/SqlError";
import * as Migrator from "@effect/sql/Migrator";
import { SqlClient } from "@effect/sql/SqlClient";
import {
  AgentCard,
  AgentId,
  type AgentId as AgentIdValue,
  type AgentSigningAuthority,
  type Ed25519PublicKey,
  InternalServerError,
  UnavailableError,
  type VerifiedAgentCard,
} from "@moltzap/client";
import { agentCardSigning, RegistryApi } from "@moltzap/client/internal";
import { Clock, Data, Effect, Either, Encoding, Schema } from "effect";
import { randomBytes } from "node:crypto";
import { AgentCardIssuedAt, issueAgentCard } from "./issuance.js";
import { registryMigration } from "./migrations/0001_registry.js";
const ed25519PublicKeyThumbprintUri = agentCardSigning.publicKeyId;

/** Storage initialization failed before the Registry became ready. */
export class RegistryStorageInitializationError extends Data.TaggedError(
  "RegistryStorageInitializationError",
)<{
  readonly reason:
    | "pre-reset"
    | "newer-schema"
    | "signer-mismatch"
    | "unavailable";
}> {}

const LEDGER_TABLE = "sharness_registry_ledger";

/**
 * Ledgers written by releases before the current reset. Their databases hold
 * AgentCards signed under a wire version outside the retained history, so
 * startup refuses them instead of serving those cards.
 */
const PRE_RESET_LEDGERS = [
  "moltzap_registry_migrations",
  "sharness_registry_migrations",
] as const;

type StorageError = UnavailableError | InternalServerError;
type StorageInput = Readonly<{
  sql: SqlClient;
  registrySignerPublicKey: Ed25519PublicKey;
  listPageSize: number;
  operationTimeoutMilliseconds: number;
}>;
type RegisterInput = Readonly<{
  request: RegistryApi.RegistryRegisterRequest;
  requestBytes: Uint8Array;
  registrySigningAuthority: AgentSigningAuthority;
}>;
type StoredOperation = Readonly<{
  requestBytes: Uint8Array;
  resultBytes: Uint8Array;
}>;

/** Durable operations needed by Registry admission and request handling. */
export interface RegistryStorage {
  readonly checkReadiness: () => Effect.Effect<void, StorageError>;
  readonly claimRegistrationNonce: (input: {
    readonly nonce: string;
    readonly expires: number;
    readonly now: number;
    readonly capacity: number;
  }) => Effect.Effect<"claimed" | "replayed" | "full", StorageError>;
  readonly register: (
    input: RegisterInput,
  ) => Effect.Effect<RegistryApi.RegistryRegisterResult, StorageError>;
  readonly lookup: (
    request: RegistryApi.RegistryLookupRequest,
  ) => Effect.Effect<RegistryApi.RegistryLookupResult, StorageError>;
  readonly list: (
    request: RegistryApi.RegistryListRequest,
  ) => Effect.Effect<RegistryApi.RegistryListResult, StorageError>;
}

/**
 * Refuses unknown applied migrations and binds the configured signer to storage.
 *
 * @param input Initialization dependencies.
 * @param input.sql Exclusive SQL capability for this Registry process.
 * @param input.registrySignerPublicKey Pinned Registry verification key.
 * @returns An effect that completes only after storage is ready.
 */
export function initializeRegistryStorage(input: {
  readonly sql: SqlClient;
  readonly registrySignerPublicKey: Ed25519PublicKey;
}): Effect.Effect<void, RegistryStorageInitializationError> {
  return runStorageInitialization(input).pipe(
    Effect.mapError((error) =>
      error instanceof RegistryStorageInitializationError
        ? error
        : new RegistryStorageInitializationError({ reason: "unavailable" }),
    ),
    Effect.catchAllDefect(() =>
      Effect.fail(
        new RegistryStorageInitializationError({ reason: "unavailable" }),
      ),
    ),
    Effect.withSpan("initializeRegistryStorage"),
  );
}

/**
 * Creates durable Registry operations over one initialized SQL client.
 *
 * @param input Storage dependencies and operation bounds.
 * @param input.sql Initialized SQL capability.
 * @param input.registrySignerPublicKey Pinned Registry verification key.
 * @param input.listPageSize Maximum complete cards in one list response.
 * @param input.operationTimeoutMilliseconds Complete SQL operation deadline.
 * @returns Durable Registry operations.
 */
export function makeRegistryStorage(input: StorageInput): RegistryStorage {
  return Object.freeze({
    checkReadiness: makeCheckReadiness(input),
    claimRegistrationNonce: makeClaimRegistrationNonce(input),
    register: makeRegister(input),
    lookup: makeLookup(input),
    list: makeList(input),
  });
}

// eslint-disable-next-line @typescript-eslint/unbound-method -- Capturing the intrinsic prevents candidate arrays from replacing the comparison method.
const everyByte = Uint8Array.prototype.every;

/** Compares complete byte sequences, rejecting detached or exotic typed arrays. */
const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  try {
    return (
      everyByte.call(left, (byte, index) => byte === right[index]) &&
      everyByte.call(right, (byte, index) => byte === left[index])
    );
    // eslint-disable-next-line agent-code-guard/bare-catch -- Detached or exotic typed arrays are non-canonical inputs, not defects. #ignore-sloppy-code-next-line[bare-catch]: The comparison returns false.
  } catch {
    return false;
  }
};

/** Rejects excess members and absent required fields at identity boundaries. */
const exactStruct = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct(fields).annotations({
    parseOptions: { exact: true, onExcessProperty: "error" },
  });

const AGENT_ID_MINT_ATTEMPTS = 8;
const migrations = Migrator.fromRecord({
  "0001_registry": registryMigration,
});

const metadataRow = exactStruct({
  signerThumbprint: Schema.String,
});
const ledgerRow = exactStruct({
  migrationId: Schema.Int,
});
const cardRow = exactStruct({
  agentCardBytes: Schema.Uint8ArrayFromSelf,
});
const operationRow = exactStruct({
  requestBytes: Schema.Uint8ArrayFromSelf,
  resultBytes: Schema.Uint8ArrayFromSelf,
});
const countRow = exactStruct({
  retained: Schema.Union(Schema.String, Schema.Number),
});
const readinessRow = exactStruct({
  ready: Schema.Literal(1),
});

const internalFailure = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, InternalServerError, R> =>
  effect.pipe(
    // eslint-disable-next-line agent-code-guard/no-effect-error-coalescing -- Stored bytes and internal cryptographic failures cross one closed, non-diagnostic storage boundary.
    Effect.mapError(() => new InternalServerError()),
  );

const exactRows = <A, I>(
  schema: Schema.Schema<A, I>,
  rows: unknown,
): Effect.Effect<readonly A[], InternalServerError> =>
  internalFailure(
    Schema.decodeUnknown(Schema.Array(schema))(rows, {
      exact: true,
      onExcessProperty: "error",
    }),
  ).pipe(Effect.map((decoded) => Object.freeze([...decoded])));

const withStorageDeadline = <A>(
  effect: Effect.Effect<A, InternalServerError | SqlError>,
  timeoutMilliseconds: number,
): Effect.Effect<A, StorageError> =>
  effect.pipe(
    Effect.catchTag("SqlError", () => Effect.fail(new UnavailableError())),
    Effect.timeoutFail({
      duration: timeoutMilliseconds,
      onTimeout: () => new UnavailableError(),
    }),
  );

const decodeStoredCard = (
  bytes: Uint8Array,
  registrySignerPublicKey: Ed25519PublicKey,
): Effect.Effect<VerifiedAgentCard, InternalServerError> =>
  internalFailure(
    RegistryApi.registryAgentCardCodec
      .decode(bytes)
      .pipe(
        Effect.flatMap((agentCard) =>
          AgentCard.verify({ agentCard, registrySignerPublicKey }),
        ),
      ),
  );

const encodeResult = (
  result: RegistryApi.RegistryRegisterResult,
): Effect.Effect<Uint8Array, InternalServerError> =>
  internalFailure(RegistryApi.registryRegisterCodec.response.encode(result));

const decodeResult = (
  bytes: Uint8Array,
  registrySignerPublicKey: Ed25519PublicKey,
): Effect.Effect<RegistryApi.RegistryRegisterResult, InternalServerError> =>
  internalFailure(
    Effect.gen(function* () {
      const result =
        yield* RegistryApi.registryRegisterCodec.response.decode(bytes);
      if (result.kind !== "registered") {
        return Object.freeze({ kind: result.kind });
      }
      const agentCard = yield* AgentCard.verify({
        agentCard: result.agentCard,
        registrySignerPublicKey,
      });
      return Object.freeze({ kind: "registered", agentCard });
    }),
  );

const mintAgentId = (): Effect.Effect<AgentIdValue, InternalServerError> =>
  internalFailure(
    Effect.try({
      try: () => `agt_${randomBytes(16).toString("base64url")}`,
      catch: () => new InternalServerError(),
    }).pipe(Effect.flatMap(Schema.decodeUnknown(AgentId))),
  );

const retainedCount = (
  rows: unknown,
): Effect.Effect<number, InternalServerError> =>
  exactRows(countRow, rows).pipe(
    Effect.map((decoded) => Number(decoded[0]?.retained ?? 0)),
  );

const mintUnusedAgentId = (
  sql: SqlClient,
): Effect.Effect<AgentIdValue, SqlError | InternalServerError> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < AGENT_ID_MINT_ATTEMPTS; attempt += 1) {
      const candidate = yield* mintAgentId();
      const rows = yield* sql`
        SELECT COUNT(*)::text AS retained
        FROM sharness_registry_agents
        WHERE agent_id = ${candidate}
      `;
      if ((yield* retainedCount(rows)) === 0) {
        return candidate;
      }
    }
    return yield* new InternalServerError();
  });

const issueTime = (): Effect.Effect<
  typeof AgentCardIssuedAt.Type,
  InternalServerError
> =>
  internalFailure(
    Clock.currentTimeMillis.pipe(
      Effect.map((milliseconds) =>
        new Date(Math.floor(milliseconds / 1_000) * 1_000)
          .toISOString()
          .replace(".000Z", "Z"),
      ),
      Effect.flatMap(Schema.decodeUnknown(AgentCardIssuedAt)),
    ),
  );

const decodeAgentIdBytes = (
  agentId: AgentIdValue,
): Effect.Effect<Uint8Array, InternalServerError> =>
  Either.match(Encoding.decodeBase64Url(agentId.slice(4)), {
    onLeft: () => Effect.fail(new InternalServerError()),
    onRight: Effect.succeed,
  });

function makeCheckReadiness(
  input: StorageInput,
): RegistryStorage["checkReadiness"] {
  return () =>
    withStorageDeadline(
      input.sql`SELECT 1 AS ready`.pipe(
        Effect.flatMap((rows) => exactRows(readinessRow, rows)),
        Effect.flatMap((rows) =>
          rows.length === 1
            ? Effect.void
            : Effect.fail(new InternalServerError()),
        ),
      ),
      input.operationTimeoutMilliseconds,
    );
}

/** The PGlite socket closes after Migrator's missing-table probe. */
const ensureMigrationTable = (sql: SqlClient) =>
  sql`
    CREATE TABLE IF NOT EXISTS ${sql(LEDGER_TABLE)} (
      migration_id integer PRIMARY KEY,
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      name text NOT NULL
    )
  `;

/** Migrator skips known ids below the ledger maximum without rejecting unknown ids. */
function checkLedger(sql: SqlClient) {
  return Effect.gen(function* () {
    yield* sql`LOCK TABLE ${sql(LEDGER_TABLE)} IN ACCESS EXCLUSIVE MODE`;
    const known = yield* migrations;
    const rows = yield* sql`
      SELECT migration_id AS "migrationId" FROM ${sql(LEDGER_TABLE)}
    `;
    const applied = yield* Schema.decodeUnknown(Schema.Array(ledgerRow))(rows);
    const knownIds = new Set(known.map(([id]) => id));
    if (applied.some((row) => !knownIds.has(row.migrationId))) {
      return yield* new RegistryStorageInitializationError({
        reason: "newer-schema",
      });
    }
  });
}

const bindStorageMetadata = (input: {
  readonly sql: SqlClient;
  readonly signerThumbprint: string;
}) =>
  input.sql.withTransaction(
    Effect.gen(function* () {
      yield* input.sql`
        INSERT INTO sharness_registry_metadata
          (singleton, signer_thumbprint)
        VALUES (true, ${input.signerThumbprint})
        ON CONFLICT (singleton) DO NOTHING
      `;
      const rows = yield* input.sql`
        SELECT
          signer_thumbprint AS "signerThumbprint"
        FROM sharness_registry_metadata
        WHERE singleton = true
        FOR UPDATE
      `;
      const metadata = yield* Schema.decodeUnknown(Schema.Tuple(metadataRow))(
        rows,
        { exact: true, onExcessProperty: "error" },
      );
      if (metadata[0].signerThumbprint !== input.signerThumbprint) {
        return yield* new RegistryStorageInitializationError({
          reason: "signer-mismatch",
        });
      }
    }),
  );

/** The ledger lock covers preflight and Migrator's transactional batch together. */
function runStorageInitialization(input: {
  readonly sql: SqlClient;
  readonly registrySignerPublicKey: Ed25519PublicKey;
}) {
  return Effect.gen(function* () {
    const legacy = yield* Effect.forEach(
      PRE_RESET_LEDGERS,
      (ledger) =>
        input.sql`SELECT to_regclass(${ledger}::text)::text AS legacy`,
      { concurrency: 1 },
    );
    if (legacy.flat().some((row) => row.legacy !== null)) {
      return yield* new RegistryStorageInitializationError({
        reason: "pre-reset",
      });
    }
    yield* ensureMigrationTable(input.sql);
    yield* input.sql.withTransaction(
      Effect.gen(function* () {
        yield* checkLedger(input.sql);
        yield* Migrator.make({})({
          loader: migrations,
          table: LEDGER_TABLE,
        }).pipe(Effect.provideService(SqlClient, input.sql));
      }),
    );
    const signerThumbprint = yield* ed25519PublicKeyThumbprintUri(
      input.registrySignerPublicKey,
    );
    yield* bindStorageMetadata({ sql: input.sql, signerThumbprint });
  });
}

const claimNonceTransaction = (
  sql: SqlClient,
  claim: Parameters<RegistryStorage["claimRegistrationNonce"]>[0],
) =>
  sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        SELECT singleton FROM sharness_registry_metadata
        WHERE singleton = true FOR UPDATE
      `;
      yield* sql`
        DELETE FROM sharness_registry_nonces
        WHERE expires_at < ${claim.now}
      `;
      const existing = yield* sql`
        SELECT COUNT(*)::text AS retained
        FROM sharness_registry_nonces WHERE nonce = ${claim.nonce}
      `;
      if ((yield* retainedCount(existing)) !== 0) {
        return "replayed" as const;
      }
      const retained = yield* sql`
        SELECT COUNT(*)::text AS retained FROM sharness_registry_nonces
      `;
      if ((yield* retainedCount(retained)) >= claim.capacity) {
        return "full" as const;
      }
      yield* sql`
        INSERT INTO sharness_registry_nonces (nonce, expires_at)
        VALUES (${claim.nonce}, ${claim.expires})
      `;
      return "claimed" as const;
    }),
  );

function makeClaimRegistrationNonce(
  input: StorageInput,
): RegistryStorage["claimRegistrationNonce"] {
  return (claim) =>
    withStorageDeadline(
      claimNonceTransaction(input.sql, claim),
      input.operationTimeoutMilliseconds,
    );
}

const findStoredOperation = (
  sql: SqlClient,
  keyThumbprint: string,
  operationId: RegistryApi.RegistryRegisterRequest["operationId"],
): Effect.Effect<StoredOperation | undefined, SqlError | InternalServerError> =>
  sql`
    SELECT
      request_bytes AS "requestBytes",
      result_bytes AS "resultBytes"
    FROM sharness_registry_operations
    WHERE public_key_thumbprint = ${keyThumbprint}
      AND operation_id = ${operationId}
  `.pipe(
    Effect.flatMap((rows) => exactRows(operationRow, rows)),
    Effect.map((rows) => rows[0]),
  );

const keyIsRegistered = (sql: SqlClient, thumbprint: string) =>
  sql`
    SELECT COUNT(*)::text AS retained
    FROM sharness_registry_agents
    WHERE public_key_thumbprint = ${thumbprint}
  `.pipe(
    Effect.flatMap(retainedCount),
    Effect.map((retained) => retained > 0),
  );

const nameIsRegistered = (
  sql: SqlClient,
  agentName: RegistryApi.RegistryRegisterRequest["agentName"],
) =>
  sql`
    SELECT COUNT(*)::text AS retained
    FROM sharness_registry_agents
    WHERE agent_name = ${agentName}
  `.pipe(
    Effect.flatMap(retainedCount),
    Effect.map((retained) => retained > 0),
  );

const insertNewAgent = (
  input: StorageInput,
  call: RegisterInput,
  keyThumbprint: string,
): Effect.Effect<
  RegistryApi.RegistryRegisterResult,
  SqlError | InternalServerError
> =>
  Effect.gen(function* () {
    const agentId = yield* mintUnusedAgentId(input.sql);
    const issuedAt = yield* issueTime();
    const agentCard = yield* internalFailure(
      issueAgentCard({
        agentId,
        principalId: call.request.principalId,
        agentName: call.request.agentName,
        publicKey: call.request.publicKey,
        issuedAt,
        registrySigningAuthority: call.registrySigningAuthority,
      }),
    );
    const agentCardBytes = yield* internalFailure(
      RegistryApi.registryAgentCardCodec.encode(agentCard),
    );
    const agentIdBytes = yield* decodeAgentIdBytes(agentId);
    yield* input.sql`
      INSERT INTO sharness_registry_agents
        (agent_id, agent_id_bytes, principal_id, agent_name,
         public_key_thumbprint, agent_card_bytes)
      VALUES
        (${agentId}, ${agentIdBytes}, ${call.request.principalId},
         ${call.request.agentName}, ${keyThumbprint}, ${agentCardBytes})
    `;
    return Object.freeze({ kind: "registered", agentCard });
  });

const decideRegistration = (
  input: StorageInput,
  call: RegisterInput,
  keyThumbprint: string,
) =>
  Effect.gen(function* () {
    if (yield* keyIsRegistered(input.sql, keyThumbprint)) {
      return Object.freeze({ kind: "key_already_registered" } as const);
    }
    if (yield* nameIsRegistered(input.sql, call.request.agentName)) {
      return Object.freeze({ kind: "name_taken" } as const);
    }
    return yield* insertNewAgent(input, call, keyThumbprint);
  });

const recordOperation = (input: {
  readonly sql: SqlClient;
  readonly keyThumbprint: string;
  readonly operationId: RegistryApi.RegistryRegisterRequest["operationId"];
  readonly requestBytes: Uint8Array;
  readonly resultBytes: Uint8Array;
}) =>
  input.sql`
    INSERT INTO sharness_registry_operations
      (public_key_thumbprint, operation_id, request_bytes, result_bytes)
    VALUES
      (${input.keyThumbprint}, ${input.operationId},
       ${input.requestBytes}, ${input.resultBytes})
  `;

const registerTransaction = (
  input: StorageInput,
  call: RegisterInput,
  keyThumbprint: string,
) =>
  input.sql.withTransaction(
    Effect.gen(function* () {
      yield* input.sql`
        SELECT singleton FROM sharness_registry_metadata
        WHERE singleton = true FOR UPDATE
      `;
      const previous = yield* findStoredOperation(
        input.sql,
        keyThumbprint,
        call.request.operationId,
      );
      if (previous !== undefined) {
        return sameBytes(previous.requestBytes, call.requestBytes)
          ? yield* decodeResult(
              previous.resultBytes,
              input.registrySignerPublicKey,
            )
          : Object.freeze({ kind: "idempotency_conflict" } as const);
      }
      const result = yield* decideRegistration(input, call, keyThumbprint);
      const resultBytes = yield* encodeResult(result);
      yield* recordOperation({
        sql: input.sql,
        keyThumbprint,
        operationId: call.request.operationId,
        requestBytes: call.requestBytes,
        resultBytes,
      });
      return result;
    }),
  );

function makeRegister(input: StorageInput): RegistryStorage["register"] {
  return (call) =>
    withStorageDeadline(
      internalFailure(
        ed25519PublicKeyThumbprintUri(call.request.publicKey),
      ).pipe(
        Effect.flatMap((thumbprint) =>
          registerTransaction(input, call, thumbprint),
        ),
      ),
      input.operationTimeoutMilliseconds,
    );
}

const findCardRows = (
  sql: SqlClient,
  request: RegistryApi.RegistryLookupRequest,
) =>
  "agentId" in request
    ? sql`
        SELECT agent_card_bytes AS "agentCardBytes"
        FROM sharness_registry_agents
        WHERE agent_id = ${request.agentId}
      `
    : sql`
        SELECT agent_card_bytes AS "agentCardBytes"
        FROM sharness_registry_agents
        WHERE agent_name = ${request.agentName}
      `;

function makeLookup(input: StorageInput): RegistryStorage["lookup"] {
  return (request) =>
    withStorageDeadline(
      Effect.gen(function* () {
        const cards = yield* findCardRows(input.sql, request).pipe(
          Effect.flatMap((rows) => exactRows(cardRow, rows)),
        );
        const card = cards[0];
        if (card === undefined) {
          return Object.freeze({ kind: "not_found" } as const);
        }
        if (cards.length !== 1) {
          return yield* new InternalServerError();
        }
        const agentCard = yield* decodeStoredCard(
          card.agentCardBytes,
          input.registrySignerPublicKey,
        );
        return Object.freeze({ kind: "found", agentCard } as const);
      }),
      input.operationTimeoutMilliseconds,
    );
}

const readListRows = (input: StorageInput, afterBytes?: Uint8Array) => {
  const maximumRows = input.listPageSize + 1;
  return afterBytes === undefined
    ? input.sql`
        SELECT agent_card_bytes AS "agentCardBytes"
        FROM sharness_registry_agents
        ORDER BY agent_id_bytes ASC
        LIMIT ${maximumRows}
      `
    : input.sql`
        SELECT agent_card_bytes AS "agentCardBytes"
        FROM sharness_registry_agents
        WHERE agent_id_bytes > ${afterBytes}
        ORDER BY agent_id_bytes ASC
        LIMIT ${maximumRows}
      `;
};

function makeList(input: StorageInput): RegistryStorage["list"] {
  return (request) =>
    withStorageDeadline(
      Effect.gen(function* () {
        const afterBytes =
          request.afterAgentId === undefined
            ? undefined
            : yield* decodeAgentIdBytes(request.afterAgentId);
        const cardRows = yield* readListRows(input, afterBytes).pipe(
          Effect.flatMap((rows) => exactRows(cardRow, rows)),
        );
        const hasMore = cardRows.length > input.listPageSize;
        const agentCards = yield* Effect.forEach(
          cardRows.slice(0, input.listPageSize),
          (row) =>
            decodeStoredCard(row.agentCardBytes, input.registrySignerPublicKey),
          { concurrency: 1 },
        );
        return Object.freeze({
          kind: "page",
          agentCards: Object.freeze(agentCards),
          hasMore,
        });
      }),
      input.operationTimeoutMilliseconds,
    );
}
