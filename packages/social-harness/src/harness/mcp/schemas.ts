/** @file JSON Schemas the daemon's tool catalog lists: closed for requests, open for results. */

import { fromJsonSchema, type JsonSchemaType } from "@modelcontextprotocol/server";
import { Array, JSONSchema, Predicate, type Schema } from "effect";

/** A Standard Schema the MCP SDK lists and validates, from a JSON Schema. */
export const makeStandardSchema = <Value>(jsonSchema: unknown) =>
  fromJsonSchema<Value>(
    // eslint-disable-next-line agent-code-guard/require-assertion-rationale -- JSONSchema.make emits the exact JsonSchemaType consumed by the pinned MCP SDK.
    jsonSchema as JsonSchemaType,
  );

/** The JSON Schema of an Effect Schema, in the draft the catalog lists. */
export const makeJsonSchema = <A, I>(schema: Schema.Schema<A, I>) =>
  JSONSchema.make(schema, { target: "jsonSchema2020-12" });

/** The same JSON Schema with every object open to properties it does not name. */
function openObjects(jsonSchema: unknown): unknown {
  if (Array.isArray(jsonSchema)) {
    return jsonSchema.map((entry) => openObjects(entry));
  }
  if (!Predicate.isRecord(jsonSchema)) {
    return jsonSchema;
  }
  return Object.fromEntries(
    Object.entries(jsonSchema).flatMap(([key, value]) =>
      key === "additionalProperties" && value === false
        ? []
        : [[key, openObjects(value)]],
    ),
  );
}

/**
 * A tool's result schema. A result may gain fields in any release, so the
 * JSON Schema a host lists is open at every object, and a host that listed an
 * older daemon's tools still accepts a newer daemon's results. The daemon
 * checks each result it returns against the exact schema.
 */
export const makeResultSchema = <Value>(jsonSchema: unknown) => {
  const exact = makeStandardSchema<Value>(jsonSchema);
  const listed = makeStandardSchema<Value>(openObjects(jsonSchema));
  return {
    "~standard": {
      ...exact["~standard"],
      jsonSchema: listed["~standard"].jsonSchema,
    },
  };
};
