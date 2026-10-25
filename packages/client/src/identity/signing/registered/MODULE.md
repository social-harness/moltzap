# client/identity/signing/registered

_`packages/client/src/identity/signing/registered`_

## Purpose

Registered-agent HTTP signing, resolution, replay defense, and verification.

## Public surface

### [`AuthenticatedHttp`](./index.ts#L69)

_Class_

```ts
export class AuthenticatedHttp extends Context.Tag(
  "@moltzap/client/AuthenticatedHttp",
)<AuthenticatedHttp, AuthenticatedHttpService>() {
  static readonly signAgentRequest = signAgentRequest;

  static readonly verifyAgentRequest: (input: {
    readonly httpRequest: HttpServerRequest.HttpServerRequest;
    readonly bodyBytes: Uint8Array;
  }) => Effect.Effect<
    VerifiedAgentRequest,
    AuthenticationError,
    AuthenticatedHttp
  > = Effect.serviceFunctionEffect(
    AuthenticatedHttp,
    (service) => service.verifyAgentRequest,
  );

  static readonly layer = (input: {
    readonly liveNonceCapacity: number;
    readonly agentCardCacheCapacity: number;
    readonly registryLookupConcurrencyLimit: number;
  }): Layer.Layer<AuthenticatedHttp, never, Registry> =>
    Layer.effect(AuthenticatedHttp, makeService({ ...input }));
}
```

Registered-agent request signing and verification.

### [`VerifiedAgentRequest`](./index.ts#L47)

_TypeAlias_

```ts
export type VerifiedAgentRequest = Readonly<{
  readonly callerAgentId: AgentIdValue;
  readonly agentCard: VerifiedAgentCard;
  readonly request: unknown;
}> &
  Brand.Brand<"VerifiedAgentRequest">;
```

Request body and caller identity established by AuthenticatedHttp.

## Files

- `index.ts`
