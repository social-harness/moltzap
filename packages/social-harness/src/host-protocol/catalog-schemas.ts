/** @file The request and result schemas the daemon's tool catalog lists: closed requests, and results a later release can extend. */

import {
  fromJsonSchema,
  type JsonSchemaType,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { Array, Brand, JSONSchema, Predicate, type Schema } from "effect";

/**
 * A tool's request schema as the catalog lists it: closed, so an argument the
 * tool does not name fails.
 * @param schema The Effect Schema of the request.
 * @returns The schema the catalog lists and the SDK validates calls against.
 */
export function requestSchema<A, I>(
  schema: Schema.Schema<A, I>,
): StandardSchemaWithJSON<A, A> {
  return closedSchema(schema);
}

/** A tool's result schema as the catalog lists it; only `resultSchema` makes one. */
export type ResultSchema<Value = unknown> = StandardSchemaWithJSON<
  Value,
  Value
> &
  Brand.Brand<"ResultSchema">;

/**
 * A tool's result schema. A result may gain fields in any release, so the
 * JSON Schema a host lists is open at every object, and a host that listed an
 * older daemon's tools still accepts a newer daemon's results. Its `validate`
 * is the exact schema the daemon checks each result it returns against.
 * @param schema The Effect Schema of the result.
 * @returns The schema the catalog lists and the daemon checks results with.
 */
export function resultSchema<A, I>(
  schema: Schema.Schema<A, I>,
): ResultSchema<A> {
  const exact = closedSchema(schema);
  const listed = openObject(
    exact["~standard"].jsonSchema.output({ target: "draft-2020-12" }),
  );
  return Brand.nominal<ResultSchema<A>>()({
    "~standard": {
      ...exact["~standard"],
      jsonSchema: { input: () => listed, output: () => listed },
    },
  });
}

/** The closed Standard Schema of an Effect Schema, which the MCP SDK validates. */
function closedSchema<A, I>(
  schema: Schema.Schema<A, I>,
): StandardSchemaWithJSON<A, A> {
  return fromJsonSchema<A>(
    // eslint-disable-next-line agent-code-guard/require-assertion-rationale -- JSONSchema.make emits the exact JsonSchemaType consumed by the pinned MCP SDK.
    JSONSchema.make(schema, { target: "jsonSchema2020-12" }) as JsonSchemaType,
  );
}

function openValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => openValue(entry));
  }
  return Predicate.isRecord(value) ? openObject(value) : value;
}

function openObject(
  object: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(object).flatMap(([key, value]) =>
      key === "additionalProperties" && value === false
        ? []
        : [[key, openValue(value)]],
    ),
  );
}
