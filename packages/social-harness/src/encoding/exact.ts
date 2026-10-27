/** @file Closed struct decoding shared by Client boundaries. */

import { Schema } from "effect";

/** Reject omitted exact fields and unknown properties at closed boundaries. */
export const exactParseOptions = {
  exact: true,
  onExcessProperty: "error" as const,
};

/**
 * A struct schema that rejects unknown and excess properties on decode, so a
 * wire value never carries fields its schema does not name.
 */
export const exactStruct = <Fields extends Schema.Struct.Fields>(
  fields: Fields,
) => Schema.Struct(fields).annotations({ parseOptions: exactParseOptions });
