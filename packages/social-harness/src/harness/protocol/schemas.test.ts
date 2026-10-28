/** @file The catalog lists result schemas a later release can extend, while the daemon checks its own results exactly. */

import { fromJsonSchema, type JsonSchemaType } from "@modelcontextprotocol/server";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { exactStruct } from "../../encoding/exact.js";
import { resultSchema } from "./schemas.js";

const Entry = exactStruct({ name: Schema.String }).annotations({
  identifier: "Entry",
});
const Page = Schema.Union(
  exactStruct({ kind: Schema.Literal("page"), entries: Schema.Array(Entry) }),
  exactStruct({ kind: Schema.Literal("empty") }),
);
const laterPage = {
  kind: "page",
  entries: [{ name: "first", addedLater: true }],
  addedLater: { kind: "new" },
};

it("lists a result schema that accepts fields a later release adds, at every depth, and checks the daemon's result exactly", () => {
  const schema = resultSchema(Page);
  const listed = fromJsonSchema(
    // eslint-disable-next-line agent-code-guard/require-assertion-rationale -- The listed JSON Schema is the object a host hands the SDK.
    schema["~standard"].jsonSchema.output({
      target: "draft-2020-12",
    }) as JsonSchemaType,
  );
  expect(listed["~standard"].validate(laterPage)).toHaveProperty("value");
  expect(schema["~standard"].validate(laterPage)).toHaveProperty("issues");
});
