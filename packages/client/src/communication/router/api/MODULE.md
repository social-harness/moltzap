# client/communication/router/api

_`packages/client/src/communication/router/api`_

## Purpose

Public Router contracts: opaque SignedMessages addressed to
explicit AgentIds, send results, and bounded endpoint-wide
PollCursors. Router carries no ConversationId, membership,
transaction, persistence, replay, or recovery semantics; those
belong to the endpoint Harness in `@moltzap/client`.

## Public surface

### [`PollCursor`](./contract.ts#L104)

_TypeAlias_

```ts
export type PollCursor = typeof PollCursor.Type;
```

Validated opaque Router poll continuation.

### [`PollCursor`](./contract.ts#L92)

_Variable_

```ts
export const PollCursor = Schema.String.pipe(
  Schema.filter(hasCanonicalCursorShape, {
    identifier: "PollCursor",
    description: "Canonical opaque Router poll continuation",
  }),
  Schema.brand("PollCursor"),
  Schema.annotations({
    identifier: "PollCursor",
    description: "Canonical opaque Router poll continuation",
  }),
)
```

Opaque, authenticated continuation for one caller and Router instance.

### [`Router`](./capability.ts#L8)

_TypeAlias_

```ts
export type Router = RouterTag;
```

Send and poll retain the internal Router's exact Effect requirement.

### [`Router`](./capability.ts#L23)

_Variable_

```ts
export const Router: RouterCapability = Object.assign(
  Context.GenericTag<Router, Context.Tag.Service<typeof RouterTag>>(
    RouterTag.key,
  ),
  {
    send: RouterTag.send,
    poll: RouterTag.poll,
    layer: (input: {
      readonly origin: HttpOrigin;
      readonly sendTimeout: Duration.Duration;
      readonly pollTimeout: Duration.Duration;
    }) => RouterTag.layer({ ...input, origin: new URL(input.origin.href) }),
  },
)
```

Trusted compositions install the same Router tag using a serialized origin.

### [`RouterConnectionError`](./contract.ts#L225)

_Class_

```ts
export class RouterConnectionError extends Data.TaggedError(
  "RouterConnectionError",
) {}
```

The Router connection could not be established or used.

### [`RouterInstanceId`](./contract.ts#L80)

_TypeAlias_

```ts
export type RouterInstanceId = typeof RouterInstanceId.Type;
```

Validated Router process identity.

### [`RouterInstanceId`](./contract.ts#L74)

_Variable_

```ts
export const RouterInstanceId = canonicalValue(
  "RouterInstanceId",
  "rti_",
  INSTANCE_BYTE_LENGTH,
)
```

Identifies one volatile Router process instance.

### [`RouterInvalidResponseError`](./contract.ts#L235)

_Class_

```ts
export class RouterInvalidResponseError extends Data.TaggedError(
  "RouterInvalidResponseError",
) {}
```

A Router response did not match the selected operation contract.

### [`RouterPollRequest`](./contract.ts#L190)

_TypeAlias_

```ts
export type RouterPollRequest = typeof pollRequest.Type;
```

One authenticated endpoint-wide poll request with an optional `pollCursor`.

### [`RouterPollRequest`](./contract.ts#L185)

_Variable_

```ts
export const RouterPollRequest: Schema.Schema<
  RouterPollRequest,
  typeof pollRequest.Encoded
> = pollRequest
```

Exact Schema for one endpoint-wide poll request.

### [`RouterPollResult`](./contract.ts#L220)

_TypeAlias_

```ts
export type RouterPollResult = typeof pollResult.Type;
```

Closed poll outcome: `batch` carries `routerInstanceId`, `signedMessages`,
and `pollCursor`; `feed_gap` carries `routerInstanceId`.
`cursor_invalid` carries only its `kind` discriminator.

### [`RouterPollResult`](./contract.ts#L211)

_Variable_

```ts
export const RouterPollResult: Schema.Schema<
  RouterPollResult,
  typeof pollResult.Encoded
> = pollResult
```

Exact Schema for every closed poll outcome.

### [`RouterRequestTimeoutError`](./contract.ts#L230)

_Class_

```ts
export class RouterRequestTimeoutError extends Data.TaggedError(
  "RouterRequestTimeoutError",
) {}
```

The configured complete Router call deadline expired.

### [`RouterSendRequest`](./contract.ts#L138)

_TypeAlias_

```ts
export type RouterSendRequest = typeof sendRequest.Type;
```

One authenticated request to accept or recover an opaque message, carrying
`expectedRouterInstanceId`, `mode` (`initial` or `retry`), and `signedMessage`.

### [`RouterSendRequest`](./contract.ts#L130)

_Variable_

```ts
export const RouterSendRequest: Schema.Schema<
  RouterSendRequest,
  typeof sendRequest.Encoded
> = sendRequest
```

Exact Schema for one send request.

### [`RouterSendResult`](./contract.ts#L178)

_TypeAlias_

```ts
export type RouterSendResult = typeof sendResult.Type;
```

Closed send outcome: `accepted` carries `routerInstanceId` and
`signedMessageDigest`; `router_restarted` carries `routerInstanceId`.
`message_invalid`, `idempotency_conflict`, and `retry_identity_unknown`
carry only their `kind` discriminator.

### [`RouterSendResult`](./contract.ts#L168)

_Variable_

```ts
export const RouterSendResult: Schema.Schema<
  RouterSendResult,
  typeof sendResult.Encoded
> = sendResult
```

Exact Schema for every closed send outcome.

### [`SignedMessageDigest`](./contract.ts#L89)

_TypeAlias_

```ts
export type SignedMessageDigest = typeof SignedMessageDigest.Type;
```

Validated SignedMessage equality receipt.

### [`SignedMessageDigest`](./contract.ts#L83)

_Variable_

```ts
export const SignedMessageDigest = canonicalValue(
  "SignedMessageDigest",
  "smd_",
  DIGEST_BYTE_LENGTH,
)
```

Equality receipt for one complete retained SignedMessage.

## Files

- `capability.ts`
- `contract.ts`
