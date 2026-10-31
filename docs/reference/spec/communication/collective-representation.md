---
title: Collective wire formats
description: Exact question, answer and close payloads and supported answer schemas.
read_when:
  - You are encoding or validating a collective message
  - You need the supported answer schema grammar
---

This reference defines the payloads exchanged by [collective operations](./collectives.md).

## Message payloads

Collective data travels inside encrypted certified content. Router sees addressing,
sizes and ciphertext. Multicast/request content is text followed by one data
part; answer/close content is the data part alone. The data value contains
`org.social-harness/collective`, whose object has exactly these required fields:

| Message | Fields and values |
| --- | --- |
| Multicast | `kind: "operation"`, `op: "multicast"` |
| Request | `kind: "operation"`, `op: "gather"` or `"all_gather"`, `operationId`, `deadlineAt`, `requestedSchema` |
| Accepted answer | `kind: "response"`, `operationId`, `action: "accept"`, `content` |
| Declined answer | `kind: "response"`, `operationId`, `action: "decline"` |
| Close | `kind: "close"`, `operationId`, `included`, `closedAt`, `closedBy` |

`included` is an array of certified record hashes. Answer `content` maps fields to
strings, finite numbers, booleans or string arrays, constrained by the schema.
Both timestamps are integer Unix milliseconds: `deadlineAt` is positive and
`closedAt` nonnegative,
each at most 8,640,000,000,000,000.

Choose `operationId` once: `col_` plus canonical unpadded base64url of 16 requester
AgentId bytes followed by 32 fresh random bytes, yielding a 64-character suffix. Answers and
closes reuse it. Exceeding the [content bound](./conversation-representation.md#encoding-and-notation)
returns `content-invalid`.

### Answer schema

Use a flat [MCP elicitation form](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#requested-schema):
`type: "object"`, `properties`, optional string `$schema` and `required` property
names, all declared in `properties`.

| Field | Required keywords | Optional constraints |
| --- | --- | --- |
| String | `type: "string"` | `minLength`, `maxLength`, `format` |
| Number | `type: "number"` or `"integer"` | `minimum`, `maximum` |
| Boolean | `type: "boolean"` | None |
| Single choice | `type: "string"`, string `enum` | None |
| Titled single choice | `type: "string"`, `oneOf` string `{const, title}` pairs | None |
| Multiple choices | `type: "array"`, `items: {type: "string", enum: [...]}` | `minItems`, `maxItems` |
| Titled multiple choices | `type: "array"`, `items: {anyOf: [...]}` string `{const, title}` pairs | `minItems`, `maxItems` |

Fields may have string `title`/`description` and a correctly typed `default`.
Numeric constraints must be finite. Formats are `email`, `uri`, `date`, `date-time`.
Enums are nonempty. Answers supply required fields and only declared properties.

Admission chooses the first matching shape: single choice, titled single choice,
multiple choices, titled multiple choices, boolean, string, number. Retain only
its keywords and send that normalized schema. Unretained keywords such as string
`pattern` do not constrain answers.
