# client/src

_`packages/client/src`_

## Purpose

Host entry for endpoint operations, delivery schemas, and immutable identity and envelope values.

## Public surface

### [`acquireHarnessEndpoint`](./harness/endpoint/index.ts#L59)

_Function_

```ts
export function acquireHarnessEndpoint(
  endpoint: URL,
): Effect.Effect<HarnessEndpoint, ConnectError, Scope.Scope>
```

Acquire one real MCP-backed endpoint and its scoped connection.

**Returns:** An endpoint whose resources remain live for the caller's scope.

### [`AgentAddress (type)`](./communication/records/values.ts#L196)

_TypeAlias_

```ts
export type AgentAddress = typeof AgentAddress.Type;
```

A validated direct destination.

### [`AgentAddress (value)`](./communication/records/values.ts#L190)

_Variable_

```ts
export const AgentAddress = addressInput.pipe(
  Schema.filter((value) => parseAgentAddress(value) !== undefined),
  Schema.brand("AgentAddress"),
  Schema.annotations({ identifier: "AgentAddress" }),
)
```

An explicit direct destination using one canonical Registry name.

### [`AgentCard (type)`](./identity/cards.ts#L97)

_Interface_

```ts
export interface AgentCard {
  readonly agentId: AgentIdValue;
  readonly principalId: PrincipalIdValue;
  readonly agentName: AgentNameValue;
  readonly publicKey: Ed25519PublicKeyValue;
  readonly issuedAt: string;
}
```

Immutable public identity fields carried by an AgentCard.

### [`AgentCard (value)`](./identity/cards.ts#L325)

_Variable_

```ts
export const AgentCard = Object.assign(agentCardSchema, {
  verify: verifyAgentCard,
  wireVersion,
}) as Schema.Schema<AgentCard, unknown> &
  Readonly<{
    readonly verify: typeof verifyAgentCard;
    readonly wireVersion: typeof wireVersion;
  }>
```

Verifies immutable Registry attestation without exposing JOSE mechanics.

### [`AgentId (type)`](./identity/agents.ts#L19)

_TypeAlias_

```ts
export type AgentId = typeof AgentId.Type;
```

Validated nominal value decoded by AgentId.

### [`AgentId (value)`](./identity/agents.ts#L13)

_Variable_

```ts
export const AgentId = canonicalIdentifier(
  "AgentId",
  "agt_",
  IDENTIFIER_BYTE_LENGTH,
)
```

Canonical network identity minted by the Registry.

### [`AgentName (type)`](./identity/agents.ts#L42)

_TypeAlias_

```ts
export type AgentName = typeof AgentName.Type;
```

Validated nominal value decoded by AgentName.

### [`AgentName (value)`](./identity/agents.ts#L31)

_Variable_

```ts
export const AgentName = Schema.String.pipe(
  Schema.minLength(3),
  Schema.maxLength(32),
  Schema.pattern(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  Schema.brand("AgentName"),
  Schema.annotations({
    identifier: "AgentName",
    description: "Registry-wide immutable agent handle",
  }),
)
```

Immutable Registry-wide human-facing agent handle.

### [`AgentSigningAuthority (type)`](./identity/keys.ts#L424)

_Interface_

```ts
export interface AgentSigningAuthority {
  readonly [agentSigningAuthorityBrand]: "AgentSigningAuthority";
}
```

Opaque authority over one imported Ed25519 private key and the X25519
opening key derived from it.

### [`AgentSigningAuthority (value)`](./identity/keys.ts#L637)

_Variable_

```ts
export const AgentSigningAuthority = Object.freeze({
  fromPkcs8,
  publicKey,
})
```

Loads and identifies one Ed25519 signing authority without exposing its
private keys or a generic signing or decryption operation.

### [`CheckedGuidance`](./firewall/outcome/index.ts#L52)

_TypeAlias_

```ts
export type CheckedGuidance = typeof checkedGuidanceSchema.Type;
```

The guidance of one checked text: a message, a request, an answer, a question or a send.

### [`CollectiveError`](./communication/collectives/forms.ts#L357)

_Class_

```ts
export class CollectiveError extends Data.TaggedError("CollectiveError")<{
  readonly id: CollectiveId;
  readonly failure: CollectiveFailure;
}> {
  override get message(): string {
    return describeCollectiveFailure(this.failure);
  }
}
```

A gather, all_gather or answer was refused. The message is what a host
hands its model as the tool error: the failed action and its cause, naming
each unreachable member or failing field. The operation id stays in the
error's data, not its message.

### [`ConnectError`](./harness/endpoint/capability.ts#L27)

_Class_

```ts
export class ConnectError extends Data.TaggedError("ConnectError")<{
  readonly reason: ConnectFailure;
}> {
  override get message(): string {
    return `connect failed: ${this.reason}`;
  }
}
```

Acquiring the endpoint connection failed.

### [`Content (type)`](./communication/records/values.ts#L95)

_TypeAlias_

```ts
export type Content = typeof Content.Type;
```

Validated nonempty semantic content.

### [`Content (value)`](./communication/records/values.ts#L90)

_Variable_

```ts
export const Content = contentStructure.pipe(
  Schema.filter(contentFits),
  Schema.annotations({ identifier: "Content" }),
)
```

Nonempty semantic content whose canonical JSON is at most 32,768 bytes.

### [`ContentPart (type)`](./communication/records/values.ts#L85)

_TypeAlias_

```ts
export type ContentPart = typeof ContentPart.Type;
```

A validated semantic message part.

### [`ContentPart (value)`](./communication/records/values.ts#L80)

_Variable_

```ts
export const ContentPart = Schema.Union(
  exactStruct({ type: Schema.Literal("text"), text: wellFormedString }),
  exactStruct({ type: Schema.Literal("data"), value: JsonValue }),
).annotations({ identifier: "ContentPart" })
```

One exact semantic part of a message.

### [`decodeHarnessMessageReadyEvent`](./harness/protocol/operations.ts#L242)

_Function_

```ts
export function decodeHarnessMessageReadyEvent(
  value: unknown,
): Effect.Effect<HarnessMessageReadyEvent, ParseResult.ParseError>
```

Decode one exact pending-delivery notification payload.

**Returns:** The validated pending delivery.

### [`decodeHarnessReadInboxResult`](./harness/protocol/operations.ts#L151)

_Variable_

```ts
export const decodeHarnessReadInboxResult =
  Schema.decodeUnknown(inboxResultSchema)
```

Decode a bounded inbox page received through the MCP transport.

### [`decodeHarnessSendErrorData`](./harness/protocol/operations.ts#L253)

_Function_

```ts
export function decodeHarnessSendErrorData(
  value: unknown,
): Effect.Effect<HarnessSendErrorData, ParseResult.ParseError>
```

Decode the error data of one refused `send_message` call.

**Returns:** The collective failure or send reason it carries.

### [`decodeHarnessSendResult`](./harness/protocol/operations.ts#L275)

_Function_

```ts
export function decodeHarnessSendResult(
  value: unknown,
): Effect.Effect<HarnessSendResult, ParseResult.ParseError>
```

Decode one `send_message` result, ignoring fields this release does not
name.

**Returns:** The operation id a gather names and the local firewall's guidance
on the admitted send, each if any.

### [`DeliveryAcknowledgeError`](./communication/conversations/errors.ts#L95)

_Class_

```ts
export class DeliveryAcknowledgeError extends Data.TaggedError(
  "DeliveryAcknowledgeError",
)<{
  readonly reason: DeliveryAcknowledgeFailure;
}> {
  override get message(): string {
    return `delivery acknowledgment failed: ${this.reason}`;
  }
}
```

Transport acknowledgment could not complete for one delivery.

### [`DirectMessage`](./communication/conversations/message.ts#L68)

_TypeAlias_

```ts
export type DirectMessage = typeof directMessage.Type;
```

One certified remote-authored direct message.

### [`Ed25519PublicKey (type)`](./identity/keys.ts#L252)

_TypeAlias_

```ts
export type Ed25519PublicKey = typeof Ed25519PublicKey.Type;
```

Validated immutable Ed25519 public JWK.

### [`Ed25519PublicKey (value)`](./identity/keys.ts#L221)

_Variable_

```ts
export const Ed25519PublicKey = Schema.transform(
  publicKeyRepresentation,
  publicKeyValueSchema,
  {
    strict: true,
    decode: (value) =>
      Object.freeze({
        crv: value.crv,
        kty: value.kty,
        x: value.x,
      }),
    encode: (value) => ({
      crv: value.crv,
      kty: value.kty,
      x: value.x,
    }),
  },
).pipe(
  Schema.brand("Ed25519PublicKey"),
  Schema.annotations({
    identifier: "Ed25519PublicKey",
    description: "Exact immutable Ed25519 public JWK",
    parseOptions: {
      exact: true,
      onExcessProperty: "error",
    },
  }),
)
```

Exact immutable Ed25519 public JWK.

### [`FirewallSendError`](./firewall/outcome/index.ts#L235)

_Class_

```ts
export class FirewallSendError extends Data.TaggedError("FirewallSendError")<
  typeof firewallRefusalSchema.Type
> {
  override get message(): string {
    const feedback = this.feedback
      .map((item) => `Next action: ${item.nextAction}. ${item.text}`)
      .join(" ");
    const description = `send withheld (check ${this.checkId}): ${refusalText[this.refusal]}.`;
    return feedback.length === 0 ? description : `${description} ${feedback}`;
  }
}
```

A refusal is returned only before an application invocation creates any intent.
Its opaque check reference survives hosts that retain only the error message.

### [`GroupAddress (type)`](./communication/records/values.ts#L205)

_TypeAlias_

```ts
export type GroupAddress = typeof GroupAddress.Type;
```

A validated canonical complete group destination.

### [`GroupAddress (value)`](./communication/records/values.ts#L199)

_Variable_

```ts
export const GroupAddress = addressInput.pipe(
  Schema.filter(isCanonicalGroupAddress),
  Schema.brand("GroupAddress"),
  Schema.annotations({ identifier: "GroupAddress" }),
)
```

A complete fixed-member group address in unsigned ASCII name order.

### [`groupMembers`](./communication/collectives/render.ts#L53)

_Function_

```ts
export function groupMembers(address: MessageAddressInput): readonly string[]
```

The agents a group address names, as `agent:` addresses, in its order; a
direct address names none. Hosts list them on a group turn.

**Returns:** The group's member addresses, or an empty list.

### [`GroupMessage`](./communication/conversations/message.ts#L70)

_TypeAlias_

```ts
export type GroupMessage = typeof groupMessage.Type;
```

One certified remote-authored fixed-group message.

### [`GuidanceBodyOrigin`](./firewall/outcome/index.ts#L82)

_TypeAlias_

```ts
export type GuidanceBodyOrigin = "peer" | "endpoint";
```

Attribution of the body quoted alongside local instructions.

### [`HarnessEndpoint`](./harness/endpoint/capability.ts#L54)

_Interface_

```ts
export interface HarnessEndpoint {
  readonly send: (
    input: SendInput,
    options?: Readonly<{
      failureDelivery?: FailureDelivery;
    }>,
  ) => Effect.Effect<
    SendResult,
    SendError | CollectiveError | FirewallSendError
  >;
  readonly messages: Stream.Stream<InboundDelivery, ListenError>;
}
```

Structural runtime capability owned by one scoped endpoint connection.
Every send is one operation or one collective response; the stream yields
inbound items.

A host whose tool returns before the send completes passes
`failureDelivery: "inbound"`: a refused gather, all_gather or response
then completes and its error arrives as an `operationFailed` item on the
stream. A multicast has no operation id, so its failure is always returned.
A firewall refusal always returns on the send call before creating an intent,
including when inbound failure delivery was requested.

### [`HistoryExportRecord (type)`](./harness/inbox/history-export.ts#L54)

_TypeAlias_

```ts
export type HistoryExportRecord = typeof HistoryExportRecord.Type;
```

A validated line of the daemon's history export.

### [`HistoryExportRecord (value)`](./harness/inbox/history-export.ts#L35)

_Variable_

```ts
export const HistoryExportRecord = Schema.Union(
  exactStruct({
    kind: Schema.Literal("inbound"),
    item: retainedInboundItem,
    at: Schema.DateTimeUtc,
  }),
  exactStruct({
    kind: Schema.Literal("outbound"),
    input: SendInput,
    outcome: historyExportSendOutcome,
    at: Schema.DateTimeUtc,
  }),
  exactStruct({
    kind: Schema.Literal("export-failed"),
    reason: Schema.String,
    at: Schema.DateTimeUtc,
  }),
).annotations({ identifier: "HistoryExportRecord" })
```

One line of the daemon's optional history export: an item as the daemon
published it, a completed `send` invocation with its input and outcome, or
the one line that says the export stopped. Readers decode the file line by
line with this schema rather than copying its shape.

### [`InboundDelivery`](./harness/endpoint/capability.ts#L36)

_Interface_

```ts
export interface InboundDelivery {
  readonly item: InboundItem;
  readonly guidance?: LocalGuidance;
  readonly acknowledge: Effect.Effect<void, DeliveryAcknowledgeError>;
}
```

One inbound item plus its transport-only acknowledgment.

### [`InboundItem (type)`](./communication/collectives/inbound.ts#L121)

_TypeAlias_

```ts
export type InboundItem = typeof InboundItem.Type;
```

A validated inbound item.

### [`InboundItem (value)`](./communication/collectives/inbound.ts#L112)

_Variable_

```ts
export const InboundItem = Schema.Union(
  multicastItem,
  collectiveRequestItem,
  collectiveResultItem,
  operationFailedItem,
).annotations({
  identifier: "InboundItem",
})
```

One inbound item, discriminated by `kind`. The endpoint consumes the
collective layer's protocol posts, posts whose collective part is malformed
or duplicated, and multicasts that carry nothing besides that part; every
other certified post becomes one item, and the endpoint itself emits
results and failures.

### [`InboundMessage (type)`](./communication/conversations/message.ts#L78)

_TypeAlias_

```ts
export type InboundMessage = typeof InboundMessage.Type;
```

A validated direct or group post.

### [`InboundMessage (value)`](./communication/conversations/message.ts#L73)

_Variable_

```ts
export const InboundMessage = Schema.Union(
  directMessage,
  groupMessage,
).annotations({ identifier: "InboundMessage" })
```

One certified remote-authored post, direct or to a fixed group.

### [`JsonValue (type)`](./communication/records/values.ts#L58)

_TypeAlias_

```ts
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
```

A value accepted by the closed semantic content boundary.

### [`JsonValue (value)`](./communication/records/values.ts#L68)

_Variable_

```ts
export const JsonValue: Schema.Schema<JsonValue> = Schema.suspend(() =>
  Schema.Union(
    Schema.Null,
    Schema.Boolean,
    Schema.JsonNumber,
    wellFormedString,
    Schema.Array(JsonValue),
    Schema.Record({ key: wellFormedString, value: JsonValue }),
  ),
).annotations({ identifier: "JsonValue" })
```

Runtime validation for the closed recursive JSON value.

### [`legacyKeys`](./environment.ts#L8)

_Function_

```ts
export function legacyKeys(
  env: Readonly<Record<string, string | undefined>>,
): readonly string[]
```

Returns only retired key names so startup diagnostics cannot expose values.

**Returns:** Sorted legacy keys, including keys with empty values.

### [`ListenError`](./communication/conversations/errors.ts#L74)

_Class_

```ts
export class ListenError extends Data.TaggedError("ListenError")<{
  readonly reason: ListenFailure;
}> {
  override get message(): string {
    return `listen failed: ${this.reason}`;
  }
}
```

The endpoint's sole inbound subscription failed.

### [`LIVE_WIRE_VERSIONS`](./identity/wire-version.ts#L39)

_Variable_

```ts
export const LIVE_WIRE_VERSIONS: DistinctWindow<typeof liveWindow> = liveWindow
```

Versions accepted at outer-envelope and authenticated HTTP admission by the
Registry, the Router, and the daemon.

### [`LiveSignedMessage`](./communication/envelope/signed-message.ts#L291)

_TypeAlias_

```ts
export type LiveSignedMessage = SignedMessage &
  Brand.Brand<"LiveSignedMessage">;
```

A decoded outer envelope whose version is admitted by the live window.

### [`LocalGuidance`](./firewall/outcome/index.ts#L76)

_TypeAlias_

```ts
export type LocalGuidance = typeof localGuidanceSchema.Type;
```

Local advice accompanies the envelope and never changes a certified item.

### [`MessageAddressInput (type)`](./communication/records/values.ts#L210)

_TypeAlias_

```ts
export type MessageAddressInput = typeof MessageAddressInput.Type;
```

A validated explicit destination input.

### [`MessageAddressInput (value)`](./communication/records/values.ts#L208)

_Variable_

```ts
export const MessageAddressInput = addressInput
```

Either accepted destination input, including noncanonical group order.

### [`MessageId (type)`](./communication/envelope/signed-message.ts#L52)

_TypeAlias_

```ts
export type MessageId = typeof MessageId.Type;
```

Validated nominal value decoded by MessageId.

### [`MessageId (value)`](./communication/envelope/signed-message.ts#L49)

_Variable_

```ts
export const MessageId = canonicalIdentifier("MessageId", "msg_", 16)
```

Sender-scoped identity of one attributed message.

### [`MessageTextError`](./communication/collectives/message-text.ts#L51)

_Class_

```ts
export class MessageTextError extends Data.TaggedError("MessageTextError")<{
  readonly operation: StatedOperation;
  readonly detail: string;
}> {
  override get message(): string {
    const action = this.operation === "answer" ? "reply" : "send";
    return `${action} failed: invalid ${this.operation}: ${this.detail}`;
  }
}
```

A message text states an operation it does not validly carry, or is plain
text that is not well-formed Unicode. The message names each failing field
so a host can hand it to its model as the tool error.

### [`parseMessageText`](./communication/collectives/message-text.ts#L94)

_Function_

```ts
export const parseMessageText = (
  to: MessageAddressInput,
  text: string,
): Either.Either<SendInput, MessageTextError>
```

Read one message text as the send it states.

**Returns:** The send input, or an error naming each field a stated operation
  gets wrong.

### [`PostId (type)`](./communication/records/values.ts#L47)

_TypeAlias_

```ts
export type PostId = typeof PostId.Type;
```

A validated author-scoped post identity.

### [`PostId (value)`](./communication/records/values.ts#L38)

_Variable_

```ts
export const PostId = Schema.String.pipe(
  Schema.filter((value) => isCanonicalIdentifier("pst_", value), {
    identifier: "PostId",
    description: "Canonical author-scoped post identity",
  }),
  Schema.brand("PostId"),
  Schema.annotations({ identifier: "PostId" }),
)
```

Opaque identity minted for one addressed-send invocation.

### [`PrincipalId (type)`](./identity/agents.ts#L28)

_TypeAlias_

```ts
export type PrincipalId = typeof PrincipalId.Type;
```

Validated nominal value decoded by PrincipalId.

### [`PrincipalId (value)`](./identity/agents.ts#L22)

_Variable_

```ts
export const PrincipalId = canonicalIdentifier(
  "PrincipalId",
  "prn_",
  IDENTIFIER_BYTE_LENGTH,
)
```

Opaque identity of the principal represented by an agent.

### [`renderCollectiveRequest`](./communication/collectives/render.ts#L71)

_Function_

```ts
export function renderCollectiveRequest(
  item: CollectiveRequestItem,
  howToAnswer: string,
  guidance?: LocalGuidance,
): string
```

A question another agent asked: who asked and until when, the question,
its form, and the exact text that answers it. Only the last line differs
by host, since each host's model sends the answer through its own tool.

**Returns:** The text of the model's turn.

### [`renderCollectiveResult`](./communication/collectives/render.ts#L118)

_Function_

```ts
export function renderCollectiveResult(item: CollectiveResultItem): string
```

A gather's or all_gather's result: the question and one line per member.
The question is quoted as JSON, so a question a peer asked cannot add
lines that read as other members' outcomes.

**Returns:** The text of the model's turn.

### [`renderContent`](./communication/collectives/render.ts#L26)

_Function_

```ts
export function renderContent(content: Content): string
```

A message's content as the text a model reads: each text part as written,
each data part as JSON, one part per line.

**Returns:** The text a host puts in the model's turn.

### [`renderLocalGuidance`](./firewall/outcome/index.ts#L92)

_Function_

```ts
export function renderLocalGuidance(
  guidance: LocalGuidance,
  quoted?: { text: string; origin: GuidanceBodyOrigin },
): string
```

Registered local instructions stay separate from attributed, quoted peer text.

**Returns:** Host-neutral model text, with no composition identifiers.

### [`SendError`](./communication/conversations/errors.ts#L54)

_Class_

```ts
export class SendError extends Data.TaggedError("SendError")<{
  readonly reason: SendFailure;
  readonly detail?: string;
  readonly issues?: ReadonlyArray<{
    readonly path: ReadonlyArray<string | number>;
    readonly message: string;
  }>;
}> {
  override get message(): string {
    return `send failed: ${this.detail ?? sendFailureText[this.reason]}`;
  }
}
```

An addressed send failed before local certification completed. `detail`
names the specific cause when the failing step knows it, such as which
agent is unknown; the message is what a host hands its model.
Validation issues expose only field paths and schema expectations.

### [`SendInput (type)`](./communication/collectives/forms.ts#L165)

_TypeAlias_

```ts
export type SendInput = typeof SendInput.Type;
```

Validated input for one send.

### [`SendInput (value)`](./communication/collectives/forms.ts#L153)

_Variable_

```ts
export const SendInput = Schema.Union(
  exactStruct({
    to: MessageAddressInput,
    text: wellFormedString,
    collective: Schema.optionalWith(CollectiveOperation, { exact: true }),
  }),
  exactStruct({
    to: MessageAddressInput,
    collectiveResponse: CollectiveResponse,
  }),
).annotations({ identifier: "SendInput" })
```

One send to one address: text with its collective operation, multicast
when `collective` is omitted, or an answer to the request open in that
address's conversation. `parseMessageText` reads both from a message's
text.

### [`SendResult`](./communication/collectives/forms.ts#L188)

_Interface_

```ts
export interface SendResult {
  readonly operationId?: CollectiveId;
  readonly guidance?: CheckedGuidance;
}
```

What a completed send returns: a collecting operation names its id, and
`guidance` carries the local firewall's advice on the admitted send, such
as a norm judgment the decision provider left unsettled.

### [`SignedMessage (type)`](./communication/envelope/signed-message.ts#L143)

_Interface_

```ts
export interface SignedMessage {
  readonly senderAgentId: AgentIdValue;
  readonly agentCardDigest: AgentCardDigestValue;
  readonly recipientAgentIds: readonly AgentIdValue[];
  readonly messageId: MessageId;
  readonly body: Uint8Array;
}
```

Immutable attributed-message fields exposed to Router consumers.

### [`SignedMessage (value)`](./communication/envelope/signed-message.ts#L541)

_Variable_

```ts
export const SignedMessage = Object.assign(signedMessageSchema, {
  live: live as Schema.Schema<LiveSignedMessage, unknown>,
  sign,
  verify,
  encodedByteLength,
  wireVersion: (message: SignedMessage): string =>
    messageState.get(message)?.wireVersion ?? "",
  maximumEncodedByteLength: MAXIMUM_ENCODED_BYTES,
}) as Schema.Schema<SignedMessage, unknown> &
  Readonly<{
    readonly live: Schema.Schema<LiveSignedMessage, unknown>;
    readonly sign: typeof sign;
    readonly verify: typeof verify;
    readonly encodedByteLength: typeof encodedByteLength;
    readonly wireVersion: (message: SignedMessage) => string;
    readonly maximumEncodedByteLength: number;
  }>
```

Opaque attributed message operations and exact representation Schema.

### [`VerifiedAgentCard`](./identity/cards.ts#L232)

_TypeAlias_

```ts
export type VerifiedAgentCard = AgentCard & Brand.Brand<"VerifiedAgentCard">;
```

AgentCard verified against a deployment-pinned Registry signer.

### [`VerifiedSignedMessage`](./communication/envelope/signed-message.ts#L275)

_TypeAlias_

```ts
export type VerifiedSignedMessage = SignedMessage &
  Brand.Brand<"VerifiedSignedMessage">;
```

SignedMessage whose sender attribution and signature are verified.

### [`WIRE_VERSION`](./identity/wire-version.ts#L13)

_Variable_

```ts
export const WIRE_VERSION = "2026.1021.3"
```

Every newly signed artifact carries this wire value. Live admission accepts
no other value, so a peer that emits a different one fails with
`version-mismatch`; package publication never determines wire compatibility.

## Package subpaths

### `@moltzap/client/service`

#### [`Daemon`](./daemon/index.ts#L82)

_Namespace_

#### [`Daemon.StartupError`](./daemon/index.ts#L90)

_Class_

```ts
  export class StartupError extends Data.TaggedError("DaemonStartupError")<{
    readonly phase: "configuration" | "storage" | "listener";
    readonly reason?:
      | "outbox-too-old"
      | "newer-schema"
      | "pre-reset"
      | "legacy-key";
    readonly keys?: readonly string[];
    readonly detail?: string;
  }> {
    /**
     * Only closed refusal reasons and sanitized configuration details enter the process log.
     * @returns The startup phase and any safe operator diagnostic.
     */
    override get message(): string {
      const reason = this.reason === undefined ? "" : ` (${this.reason})`;
      const detail = this.detail === undefined ? "" : `: ${this.detail}`;
      let remedy = "";
      if (this.reason === "pre-reset") {
        remedy =
          ". Start with a fresh state directory and register again; see https://github.com/social-harness/moltzap/blob/main/docs/guides/upgrades.mdx#apply-a-reset-release.";
      } else if (this.reason === "outbox-too-old") {
        remedy =
          ". Drain the outbox on the previous release before upgrading, or apply a reset release; see https://github.com/social-harness/moltzap/blob/main/docs/guides/upgrades.mdx#apply-a-reset-release.";
      }
      return `sharnessd startup failed in phase ${this.phase}${reason}${detail}${remedy}`;
    }
  }
```

Closed startup phase with sanitized configuration details.

#### [`Daemon.FirewallOptions`](./daemon/index.ts#L87)

_TypeAlias_

```ts
  export type FirewallOptions = InstalledFirewallOptions;
```

Trusted process composition fixes code and evidence while owner tools edit English rules.

#### [`Daemon.help`](./daemon/index.ts#L84)

_Variable_

```ts
  export const help = processHelp
```

Usage text listing the daemon process's environment variables.

#### [`Daemon.layer`](./daemon/index.ts#L179)

_Variable_

```ts
  export const layer: Layer.Layer<never, StartupError> = Layer.scopedDiscard(
    runDaemon(),
  ).pipe(Layer.provide(telemetry))
```

Complete production process composition for `sharnessd`, with the
firewall `SHARNESS_MESSAGE_POLICY_FILE` describes when it is set.

#### [`Daemon.withFirewall`](./daemon/index.ts#L189)

_Function_

```ts
  export const withFirewall = (
    options: FirewallOptions,
  ): Layer.Layer<never, StartupError>
```

Fixed middleware and persisted English rules are installed before the daemon accepts host calls.
The environment must not also name a message-policy document.

**Returns:** The complete daemon layer with both message boundaries checked.

#### [`CheckInputError`](./firewall/evaluator/contract/index.ts#L233)

_Class_

```ts
export class CheckInputError extends Data.TaggedError("CheckInputError")<{
  readonly reason: "settings" | "registration" | "message" | "context";
}> {}
```

Invalid construction or evidence is a typed failure, never permission.

#### [`DecisionProviderError`](./firewall/evaluator/contract/index.ts#L388)

_Class_

```ts
export class DecisionProviderError extends Data.TaggedError(
  "DecisionProviderError",
)<{
  readonly reason:
    | "configuration"
    | "transport"
    | "http"
    | "timeout"
    | "invalid-response"
    | "budget"
    | "defect";
  readonly status?: number;
  readonly response?: string;
  /**
   * The usage a response body reported before the call failed, named as an
   * answered response names it, so the call's cost stays accountable. A
   * failure without a parsed body has none.
   */
  readonly accounting?: Pick<DecisionResponse, "provider" | "model" | "usage">;
}> {}
```

The adapter scrubs credentials before retaining optional private diagnostics.

#### [`FirewallPolicyError`](./firewall/evaluator/contract/index.ts#L641)

_Class_

```ts
export class FirewallPolicyError extends Data.TaggedError(
  "FirewallPolicyError",
)<{
  readonly ruleId?: string;
  readonly reason:
    | "not-configured"
    | "invalid-rule"
    | "fixed-rule"
    | "build-failed"
    | "persistence-failed";
}> {}
```

A failed edit never replaces the active installation or retained editable document.

#### [`MiddlewareError`](./firewall/evaluator/contract/index.ts#L178)

_Class_

```ts
export class MiddlewareError extends Data.TaggedError("MiddlewareError")<{
  readonly reason:
    | "unavailable"
    | "timeout"
    | "invalid-result"
    | "budget"
    | "defect";
}> {}
```

Operational failures carry closed reasons, never arbitrary exception text.

#### [`Registry`](./identity/registry/index.ts#L13)

_Class_

```ts
export class Registry extends Context.Tag("@moltzap/client/Registry")<
  Registry,
  RegistryClientService
>() {
  static readonly register = Effect.serviceFunctionEffect(
    Registry,
    (service) => service.register,
  );

  static readonly lookup = Effect.serviceFunctionEffect(
    Registry,
    (service) => service.lookup,
  );

  static readonly list = Effect.serviceFunctionEffect(
    Registry,
    (service) => service.list,
  );

  static readonly layer = (input: {
    readonly origin: URL;
    readonly registrySignerPublicKey: Ed25519PublicKey;
    readonly requestTimeout: Duration.Duration;
  }): Layer.Layer<Registry, never, HttpClient.HttpClient> =>
    Layer.effect(Registry, makeRegistryService(input));
}
```

Bootstrap registration and immutable identity resolution.

#### [`RegistryConnectionError`](./identity/registry/contract.ts#L28)

_Class_

```ts
export class RegistryConnectionError extends Data.TaggedError(
  "RegistryConnectionError",
) {}
```

The Registry connection could not be established or used.

#### [`RegistryInvalidResponseError`](./identity/registry/contract.ts#L38)

_Class_

```ts
export class RegistryInvalidResponseError extends Data.TaggedError(
  "RegistryInvalidResponseError",
) {}
```

A Registry response did not match the selected operation contract.

#### [`RegistryRequestTimeoutError`](./identity/registry/contract.ts#L33)

_Class_

```ts
export class RegistryRequestTimeoutError extends Data.TaggedError(
  "RegistryRequestTimeoutError",
) {}
```

The configured complete Registry call deadline expired.

#### [`Router`](./communication/router/api/client.ts#L51)

_Class_

```ts
export class Router extends Context.Tag("@moltzap/client/Router")<
  Router,
  RouterClientService
>() {
  static readonly send: (input: {
    readonly request: RouterSendRequest;
    readonly callerAgentId: AgentId;
    readonly signingAuthority: AgentSigningAuthority;
  }) => Effect.Effect<RouterSendResult, RouterClientError, Router> =
    Effect.serviceFunctionEffect(Router, (service) => service.send);

  static readonly poll: (input: {
    readonly request: RouterPollRequest;
    readonly callerAgentId: AgentId;
    readonly signingAuthority: AgentSigningAuthority;
  }) => Effect.Effect<RouterPollResult, RouterClientError, Router> =
    Effect.serviceFunctionEffect(Router, (service) => service.poll);

  static readonly layer = (input: {
    readonly origin: URL;
    readonly sendTimeout: Duration.Duration;
    readonly pollTimeout: Duration.Duration;
  }): Layer.Layer<Router, never, HttpClient.HttpClient> =>
    Layer.effect(Router, makeRouterClient(input));
}
```

Opaque message acceptance and endpoint-wide bounded polling.

#### [`RouterConnectionError`](./communication/router/api/contract.ts#L225)

_Class_

```ts
export class RouterConnectionError extends Data.TaggedError(
  "RouterConnectionError",
) {}
```

The Router connection could not be established or used.

#### [`RouterInvalidResponseError`](./communication/router/api/contract.ts#L235)

_Class_

```ts
export class RouterInvalidResponseError extends Data.TaggedError(
  "RouterInvalidResponseError",
) {}
```

A Router response did not match the selected operation contract.

#### [`RouterRequestTimeoutError`](./communication/router/api/contract.ts#L230)

_Class_

```ts
export class RouterRequestTimeoutError extends Data.TaggedError(
  "RouterRequestTimeoutError",
) {}
```

The configured complete Router call deadline expired.

#### [`DecisionProvider`](./firewall/evaluator/contract/index.ts#L410)

_Interface_

```ts
export interface DecisionProvider {
  /** Requested provider configuration, retained even when no response arrives. */
  readonly provenance?: PrivateCheckTrace;
  readonly decide: (
    request: DecisionRequest,
  ) => Effect.Effect<DecisionResponse, DecisionProviderError>;
}
```

Entirely code-based chains have no dependency on this optional capability.

#### [`DecisionRequest`](./firewall/evaluator/contract/index.ts#L353)

_Interface_

```ts
export interface DecisionRequest {
  readonly stage: PolicyStage;
  readonly state: string;
  readonly questions: Readonly<
    Record<
      string,
      {
        readonly ruleId: string;
        readonly purpose: "assessment" | "subject";
        readonly subject?: string;
        readonly instructions: string;
        readonly criteria: Readonly<Record<string, string>>;
      }
    >
  >;
}
```

Provider input contains explicit questions and state, never execution authority.

#### [`DecisionResponse`](./firewall/evaluator/contract/index.ts#L371)

_Interface_

```ts
export class DecisionResponse extends Schema.Class<DecisionResponse>(
  "DecisionResponse",
)({
  provider: identifier,
  model: identifier,
  answers: Schema.Record({
    key: identifier,
    value: Schema.Struct({
      choice: identifier,
      probabilities: Schema.Record({ key: identifier, value: probability }),
    }),
  }),
  usage: Schema.Record({ key: identifier, value: Schema.NonNegativeInt }),
  raw: Schema.String,
}) {}
```

Raw provider bytes and distributions survive routing unchanged.

#### [`EnglishPolicySettings`](./firewall/evaluator/contract/index.ts#L337)

_Interface_

```ts
export class EnglishPolicySettings extends Schema.Class<EnglishPolicySettings>(
  "EnglishPolicySettings",
)({
  minimumProbability: Schema.Number.pipe(Schema.between(0.5, 1)),
  maximumRequestBytes: Schema.Positive.pipe(Schema.int()),
  timeoutMilliseconds: Schema.Positive.pipe(Schema.int()),
}) {}
```

Bytes bound allocation, not tokenizer capacity; probability is a routing setting.

#### [`EnglishRule`](./firewall/evaluator/contract/index.ts#L117)

_Interface_

```ts
export class EnglishRule extends Schema.Class<EnglishRule>("EnglishRule")({
  ...RuleDescription.fields,
  text: Schema.NonEmptyString,
}) {}
```

Text is interpreted by the provider; it is never compiled into executable code.

#### [`Firewall`](./firewall/evaluator/contract/index.ts#L325)

_Interface_

```ts
export interface Firewall {
  readonly checkIncoming: (
    message: Message,
    context: MessageContext,
  ) => Effect.Effect<IncomingCheck, CheckInputError>;
  readonly checkOutgoing: (
    draft: Message,
    context: MessageContext,
  ) => Effect.Effect<FirewallCheck, CheckInputError>;
}
```

Checking returns data; Client separately owns fresh, atomic send/delivery admission.

#### [`FirewallSettings`](./firewall/evaluator/contract/index.ts#L223)

_Interface_

```ts
export class FirewallSettings extends Schema.Class<FirewallSettings>(
  "FirewallSettings",
)({
  timeoutMilliseconds: Schema.Positive.pipe(Schema.int()),
  middlewareTimeoutMilliseconds: Schema.Positive.pipe(Schema.int()),
  maximumInputBytes: Schema.Positive.pipe(Schema.int()),
  maximumResultBytes: Schema.Positive.pipe(Schema.int()),
}) {}
```

Sequential execution is bounded per entry and across the whole attempt.

#### [`Message`](./firewall/evaluator/contract/index.ts#L39)

_Interface_

```ts
export class Message extends Schema.Class<Message>("Message")({
  id: identifier,
  sender: identifier,
  recipients: Schema.NonEmptyArray(identifier),
  text: Schema.String,
  operation: Schema.optional(messageOperation),
}) {}
```

Attribution is supplied by Client, never inferred from names in the body.
`operation` is absent for a plain message.

#### [`MessageContext`](./firewall/evaluator/contract/index.ts#L65)

_Interface_

```ts
export class MessageContext extends Schema.Class<MessageContext>(
  "MessageContext",
)({
  agentId: identifier,
  principal: identifier,
  participants: Schema.Array(
    Schema.Struct({
      agentId: identifier,
      principal: identifier,
    }),
  ),
  history: Schema.Array(HistoryEntry),
  /** Older certified records outside the configured window are not an evidence gap. */
  earlierHistoryOmitted: Schema.optional(Schema.Boolean),
  /** Epoch milliseconds when Client captured the context, so a deadline can be judged and a check replayed. */
  now: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  facts: Schema.Array(
    Schema.Struct({
      id: identifier,
      source: identifier,
      text: Schema.NonEmptyString,
      visibility,
    }),
  ),
  gaps: Schema.Array(Schema.NonEmptyString),
}) {}
```

Trusted composition supplies authorized earlier evidence and distinct agent and principal identities.

#### [`MessageMiddleware`](./firewall/evaluator/contract/index.ts#L211)

_Interface_

```ts
export interface MessageMiddleware {
  readonly id: string;
  readonly revision: string;
  readonly rules: readonly RuleDescription[];
  /** Descriptive audit data declared by trusted composition, never authority. */
  readonly provenance?: PrivateCheckTrace;
  readonly check: (
    input: MiddlewareInput,
  ) => Effect.Effect<MiddlewareResult, MiddlewareError>;
}
```

Code and English policies have the same contract. Registered code is trusted;
it receives no conversation or store capability and must not retain conversation
state or perform messaging side effects.

#### [`MiddlewareInput`](./firewall/evaluator/contract/index.ts#L199)

_Interface_

```ts
export class MiddlewareInput extends Schema.Class<MiddlewareInput>(
  "MiddlewareInput",
)({
  event: messageEvent,
  context: MessageContext,
}) {}
```

Each invocation gets immutable message evidence and authorized context.

#### [`MiddlewareResult`](./firewall/evaluator/contract/index.ts#L169)

_Interface_

```ts
export class MiddlewareResult extends Schema.Class<MiddlewareResult>(
  "MiddlewareResult",
)({
  findings: Schema.Array(policyFinding),
  expectations: Schema.Array(NormExpectation),
  trace: Schema.optional(PrivateCheckTrace),
}) {}
```

A result is atomic: interrupted middleware has no returned partial findings.

#### [`RuleDescription`](./firewall/evaluator/contract/index.ts#L102)

_Interface_

```ts
export class RuleDescription extends Schema.Class<RuleDescription>(
  "RuleDescription",
)({
  id: identifier,
  kind: Schema.Literal("safety", "norm"),
  guidance: Schema.optional(Schema.NonEmptyString),
  feedback: Schema.optional(
    Schema.Struct({
      text: Schema.NonEmptyString,
      nextAction,
    }),
  ),
}) {}
```

Runtime advice can only select templates registered by trusted composition.

#### [`MessagePolicy (type)`](./firewall/policy/document/index.ts#L217)

_TypeAlias_

```ts
export type MessagePolicy = typeof MessagePolicy.Type;
```

One decoded message-policy document, with Client's defaults filled in.

#### [`OperationId (type)`](./identity/registry/contract.ts#L25)

_TypeAlias_

```ts
export type OperationId = typeof OperationId.Type;
```

Validated nominal value decoded by OperationId.

#### [`PollCursor (type)`](./communication/router/api/contract.ts#L104)

_TypeAlias_

```ts
export type PollCursor = typeof PollCursor.Type;
```

Validated opaque Router poll continuation.

#### [`RegistryListRequest (type)`](./identity/registry/contract.ts#L90)

_TypeAlias_

```ts
export type RegistryListRequest = typeof RegistryListRequest.Type;
```

Validated Registry list continuation request.

#### [`RegistryListResult`](./identity/registry/contract.ts#L105)

_TypeAlias_

```ts
export type RegistryListResult = Readonly<{
  kind: "page";
  agentCards: readonly VerifiedAgentCard[];
  hasMore: boolean;
}>;
```

One deterministic page of complete immutable AgentCards.

#### [`RegistryLookupRequest (type)`](./identity/registry/contract.ts#L78)

_TypeAlias_

```ts
export type RegistryLookupRequest = typeof RegistryLookupRequest.Type;
```

Validated Registry lookup selector.

#### [`RegistryLookupResult`](./identity/registry/contract.ts#L100)

_TypeAlias_

```ts
export type RegistryLookupResult =
  | Readonly<{ kind: "found"; agentCard: VerifiedAgentCard }>
  | Readonly<{ kind: "not_found" }>;
```

Closed domain outcome from one public identity lookup.

#### [`RegistryRegisterRequest (type)`](./identity/registry/contract.ts#L52)

_TypeAlias_

```ts
export type RegistryRegisterRequest = typeof RegistryRegisterRequest.Type;
```

Validated Registry bootstrap registration request.

#### [`RegistryRegisterResult`](./identity/registry/contract.ts#L93)

_TypeAlias_

```ts
export type RegistryRegisterResult =
  | Readonly<{ kind: "registered"; agentCard: VerifiedAgentCard }>
  | Readonly<{ kind: "name_taken" }>
  | Readonly<{ kind: "key_already_registered" }>
  | Readonly<{ kind: "idempotency_conflict" }>;
```

Closed domain outcome from one bootstrap registration attempt.

#### [`RouterInstanceId (type)`](./communication/router/api/contract.ts#L80)

_TypeAlias_

```ts
export type RouterInstanceId = typeof RouterInstanceId.Type;
```

Validated Router process identity.

#### [`RouterPollRequest (type)`](./communication/router/api/contract.ts#L190)

_TypeAlias_

```ts
export type RouterPollRequest = typeof pollRequest.Type;
```

One authenticated endpoint-wide poll request with an optional `pollCursor`.

#### [`RouterPollResult (type)`](./communication/router/api/contract.ts#L220)

_TypeAlias_

```ts
export type RouterPollResult = typeof pollResult.Type;
```

Closed poll outcome: `batch` carries `routerInstanceId`, `signedMessages`,
and `pollCursor`; `feed_gap` carries `routerInstanceId`.
`cursor_invalid` carries only its `kind` discriminator.

#### [`RouterSendRequest (type)`](./communication/router/api/contract.ts#L138)

_TypeAlias_

```ts
export type RouterSendRequest = typeof sendRequest.Type;
```

One authenticated request to accept or recover an opaque message, carrying
`expectedRouterInstanceId`, `mode` (`initial` or `retry`), and `signedMessage`.

#### [`RouterSendResult (type)`](./communication/router/api/contract.ts#L178)

_TypeAlias_

```ts
export type RouterSendResult = typeof sendResult.Type;
```

Closed send outcome: `accepted` carries `routerInstanceId` and
`signedMessageDigest`; `router_restarted` carries `routerInstanceId`.
`message_invalid`, `idempotency_conflict`, and `retry_identity_unknown`
carry only their `kind` discriminator.

#### [`SignedMessageDigest (type)`](./communication/router/api/contract.ts#L89)

_TypeAlias_

```ts
export type SignedMessageDigest = typeof SignedMessageDigest.Type;
```

Validated SignedMessage equality receipt.

#### [`decodeMessagePolicy`](./firewall/policy/document/index.ts#L226)

_Variable_

```ts
export const decodeMessagePolicy = Schema.decodeUnknown(
  Schema.parseJson(
    Schema.compose(
      Schema.Struct({
        ...document.fields,
        english: Schema.optional(
          Schema.Struct({
            ...englishDocument.fields,
            fixedRules: retainedEnglishRules,
            initialRules: retainedEnglishRules,
          }),
        ),
      }),
      MessagePolicy,
    ),
  ),
  { onExcessProperty: "error" },
)
```

Decodes the text of a message-policy document, refusing any property it
does not name, so a misspelled or newer setting never silently weakens the
policy.

#### [`makeEnglishPolicy`](./firewall/evaluator/english.ts#L249)

_Variable_

```ts
export const makeEnglishPolicy = Effect.fn("makeEnglishPolicy")(
  function* (options: {
    readonly id: string;
    readonly rules: readonly EnglishRule[];
    readonly provider: DecisionProvider;
    readonly settings: unknown;
    readonly fixedRuleIds?: readonly string[];
  }): Effect.fn.Return<MessageMiddleware, CheckInputError> {
    const settings = yield* decodeFrozen(
      EnglishPolicySettings,
      options.settings,
    ).pipe(
      Effect.catchTag("ParseError", () =>
        Effect.fail(new CheckInputError({ reason: "settings" })),
      ),
    );
    const { id, rules } = yield* decodeFrozen(
      Schema.Struct({
        id: Schema.NonEmptyTrimmedString,
        rules: Schema.NonEmptyArray(EnglishRule),
      }),
      { id: options.id, rules: options.rules },
    ).pipe(
      Effect.catchTag("ParseError", () =>
        Effect.fail(new CheckInputError({ reason: "registration" })),
      ),
    );
    if (new Set(rules.map((rule) => rule.id)).size !== rules.length) {
      return yield* new CheckInputError({ reason: "registration" });
    }
    const descriptions = yield* ruleDescriptions(rules);
    const revision = englishRevision(rules, settings);
    const provider = Object.freeze({
      decide: options.provider.decide.bind(options.provider),
    });
    return Object.freeze({
      id,
      revision,
      rules: descriptions,
      provenance: englishProvenance(
        rules,
        settings,
        options.provider,
        options.fixedRuleIds,
      ),
      check: (input: MiddlewareInput) =>
        checkEnglish(input, { rules, revision }, provider, settings),
    });
  },
)
```

Freezes English documents and provider settings for repeated checks in either
direction. Question semantics and documents determine the recorded revision.
`fixedRuleIds` names the rules composition fixed against owner edits; it is
recorded in the provenance only, so a retained check keeps which of its
rules were fixed, and never changes checking.

```mermaid
flowchart TD
  I[Original message and context] --> A[Applicability]
  A --> S[Personal trust]
  S --> N[Norm expectations from permitted evidence]
  N --> C[Outgoing conformance against the settled expectations]
  C --> R[Return all findings and private stage trace]
```

#### [`makeFirewall`](./firewall/evaluator/index.ts#L70)

_Variable_

```ts
export const makeFirewall = Effect.fn("makeFirewall")(function* (options: {
  readonly incoming: readonly MessageMiddleware[];
  readonly outgoing: readonly MessageMiddleware[];
  readonly settings: unknown;
}): Effect.fn.Return<Firewall, CheckInputError> {
  const settings = yield* decodeFrozen(FirewallSettings, options.settings).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new CheckInputError({ reason: "settings" })),
    ),
  );
  const incoming = yield* makeChain(options.incoming, settings);
  const outgoing = yield* makeChain(options.outgoing, settings);
  return Object.freeze({
    checkIncoming: (message: Message, context: MessageContext) =>
      incoming({ direction: "incoming", message }, context).pipe(
        Effect.flatMap((result) =>
          result.judgment === "revise"
            ? Effect.fail(new CheckInputError({ reason: "message" }))
            : Effect.succeed({ ...result, judgment: result.judgment }),
        ),
      ),
    checkOutgoing: (message: Message, context: MessageContext) =>
      outgoing({ direction: "outgoing", message }, context),
  });
})
```

Runs every installed check in order within the budget. Refusals accumulate;
only Client can apply the result to an exact candidate with fresh evidence.
Cancellation propagates, so an interrupted check never returns permission.

```mermaid
flowchart TD
  I[Incoming message or outgoing draft] --> C[Capture immutable context]
  C --> M[Run each registered middleware]
  M --> V[Validate and retain each atomic result]
  V --> D[Compose all findings and permitted advice]
  D --> R[Return to Client for enforcement]
```

#### [`MessagePolicy (value)`](./firewall/policy/document/index.ts#L193)

_Variable_

```ts
export const MessagePolicy = document.pipe(
  Schema.filter(
    (policy) =>
      policy.decisionProvider !== undefined || !needsDecisionProvider(policy),
    {
      message: () =>
        "decisionProvider is required for English rules and the collective norms",
    },
  ),
  Schema.filter(
    (policy) =>
      policy.decisionProvider?.kind !== "unavailable" ||
      !installsCollectiveNorms(policy),
    {
      message: () => "the collective norms need an available decisionProvider",
    },
  ),
  Schema.filter((policy) => uniqueEnglishRuleIds(policy), {
    message: () =>
      "english rule ids must be unique across fixedRules and initialRules",
  }),
)
```

The message policy of one daemon: its firewall mode, the built-in code
middleware of each direction in chain order, its fixed and initial
editable English rules, the decision provider those rules and the
collective norms need, and the check bounds. Absent settings take Client's
defaults. English rules or the collective norms without a decision
provider, the collective norms with the `unavailable` provider, which would
leave every one of their English checks unavailable, and an English rule
id given twice across the fixed and initial rules are refused.

#### [`messagePolicyFirewall`](./firewall/policy/compose.ts#L63)

_Variable_

```ts
export const messagePolicyFirewall = Effect.fn("messagePolicyFirewall")(
  function* (policy: MessagePolicy, provider: DecisionProvider) {
    if (hasBehaviorPaths(policy)) {
      return yield* new CheckInputError({ reason: "registration" });
    }
    return yield* composeFirewall(policy, provider, []);
  },
)
```

The firewall installation of one message-policy document: its built-in
middleware in chain order, its English rules assessed by `provider`, and
its settings. This is the trusted-composition hook: a composition that
brings its own decision provider installs the result with
`Daemon.withFirewall`. `codeDigest` is the SHA-256 of the Client release,
the mode, each registration's id and revision, the fixed English rules
and behavior bytes, the decision provider and the settings. It leaves out
what differs between the agents of one arm: the facilitator role, which no revision holds, the
allowed-sender list and the initial editable rules, so every member
records the same digest.
Nonempty behavior paths fail with `CheckInputError` (`registration`); only
file loading resolves behavior paths.

#### [`OperationId (value)`](./identity/registry/contract.ts#L22)

_Variable_

```ts
export const OperationId = canonicalIdentifier("OperationId", "opn_", 16)
```

Idempotency identity for a registration operation.

#### [`PollCursor (value)`](./communication/router/api/contract.ts#L92)

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

#### [`RegistryListRequest (value)`](./identity/registry/contract.ts#L82)

_Variable_

```ts
export const RegistryListRequest = exactStruct({
  afterAgentId: Schema.optional(AgentId).annotations({
    description:
      "Exclusive agent identity cursor for Registry listing; omit to start the first page.",
  }),
}).annotations({ identifier: "RegistryListRequest" })
```

Closed Registry list continuation request.

#### [`RegistryLookupRequest (value)`](./identity/registry/contract.ts#L56)

_Variable_

```ts
export const RegistryLookupRequest = Schema.Union(
  exactStruct({
    agentId: Schema.propertySignature(AgentId).annotations({
      description:
        "Look up this Registry-minted agent identity (agt_ plus canonical base64url for 16 bytes); use alone.",
    }),
  }),
  exactStruct({
    agentName: Schema.propertySignature(AgentName).annotations({
      description:
        "Look up this immutable Registry-wide agent handle; use alone.",
    }),
  }),
).annotations({
  identifier: "RegistryLookupRequest",
  parseOptions: {
    exact: true,
    onExcessProperty: "error",
  },
})
```

Closed Registry lookup selector.

#### [`RegistryRegisterRequest (value)`](./identity/registry/contract.ts#L44)

_Variable_

```ts
export const RegistryRegisterRequest = exactStruct({
  operationId: OperationId,
  principalId: PrincipalId,
  agentName: AgentName,
  publicKey: Ed25519PublicKey,
}).annotations({ identifier: "RegistryRegisterRequest" })
```

Closed Registry bootstrap registration request.

#### [`RouterInstanceId (value)`](./communication/router/api/contract.ts#L74)

_Variable_

```ts
export const RouterInstanceId = canonicalValue(
  "RouterInstanceId",
  "rti_",
  INSTANCE_BYTE_LENGTH,
)
```

Identifies one volatile Router process instance.

#### [`RouterPollRequest (value)`](./communication/router/api/contract.ts#L185)

_Variable_

```ts
export const RouterPollRequest: Schema.Schema<
  RouterPollRequest,
  typeof pollRequest.Encoded
> = pollRequest
```

Exact Schema for one endpoint-wide poll request.

#### [`RouterPollResult (value)`](./communication/router/api/contract.ts#L211)

_Variable_

```ts
export const RouterPollResult: Schema.Schema<
  RouterPollResult,
  typeof pollResult.Encoded
> = pollResult
```

Exact Schema for every closed poll outcome.

#### [`RouterSendRequest (value)`](./communication/router/api/contract.ts#L130)

_Variable_

```ts
export const RouterSendRequest: Schema.Schema<
  RouterSendRequest,
  typeof sendRequest.Encoded
> = sendRequest
```

Exact Schema for one send request.

#### [`RouterSendResult (value)`](./communication/router/api/contract.ts#L168)

_Variable_

```ts
export const RouterSendResult: Schema.Schema<
  RouterSendResult,
  typeof sendResult.Encoded
> = sendResult
```

Exact Schema for every closed send outcome.

#### [`SignedMessageDigest (value)`](./communication/router/api/contract.ts#L83)

_Variable_

```ts
export const SignedMessageDigest = canonicalValue(
  "SignedMessageDigest",
  "smd_",
  DIGEST_BYTE_LENGTH,
)
```

Equality receipt for one complete retained SignedMessage.

#### [`makeJevDecisionProvider`](./firewall/evaluator/jev.ts#L190)

_Function_

```ts
export function makeJevDecisionProvider(options: {
  readonly apiKey: Redacted.Redacted;
  readonly model: string;
}): DecisionProvider
```

Uses the fixed TypeSafe origin and an explicitly pinned model. No retry,
environment lookup or credential serialization occurs here. The evaluator
owns timeouts; the Effect is interruptible through response-body consumption.

## Files

- `communication/collectives/answer-formats.ts`
- `communication/collectives/failures.ts`
- `communication/collectives/forms.ts`
- `communication/collectives/inbound.ts`
- `communication/collectives/index.ts`
- `communication/collectives/message-text.ts`
- `communication/collectives/operation.ts`
- `communication/collectives/part/grammar.ts`
- `communication/collectives/part/index.ts`
- `communication/collectives/ports.ts`
- `communication/collectives/README.md`
- `communication/collectives/received-request.ts`
- `communication/collectives/render.ts`
- `communication/collectives/request-sends.ts`
- `communication/collectives/shared-answers.ts`
- `communication/collectives/validation.ts`
- `communication/conversations/address.ts`
- `communication/conversations/certification/dissemination.ts`
- `communication/conversations/certification/index.ts`
- `communication/conversations/certification/README.md`
- `communication/conversations/errors.ts`
- `communication/conversations/history/build.ts`
- `communication/conversations/history/certificates/index.ts`
- `communication/conversations/history/index.ts`
- `communication/conversations/history/README.md`
- `communication/conversations/history/stored.ts`
- `communication/conversations/index.ts`
- `communication/conversations/message.ts`
- `communication/conversations/outbox.ts`
- `communication/conversations/README.md`
- `communication/conversations/reanchor/empty.ts`
- `communication/conversations/reanchor/index.ts`
- `communication/conversations/reanchor/votes.ts`
- `communication/conversations/recovery/barrier.ts`
- `communication/conversations/recovery/catch-up.ts`
- `communication/conversations/recovery/index.ts`
- `communication/conversations/recovery/README.md`
- `communication/conversations/recovery/successor.ts`
- `communication/conversations/retry-markers.ts`
- `communication/conversations/runtime/index.ts`
- `communication/conversations/send.ts`
- `communication/conversations/startup.ts`
- `communication/envelope/sealed-body.ts`
- `communication/envelope/signed-message.ts`
- `communication/envelope/wire-profile.ts`
- `communication/README.md`
- `communication/records/encoding/codec.ts`
- `communication/records/encoding/index.ts`
- `communication/records/index.ts`
- `communication/records/README.md`
- `communication/records/schemas.ts`
- `communication/records/values.ts`
- `communication/records/verification.ts`
- `communication/router/api/client.ts`
- `communication/router/api/contract.ts`
- `communication/router/api/index.ts`
- `communication/router/index.ts`
- `communication/router/outage.ts`
- `communication/router/worker/index.ts`
- `communication/store/anchors.ts`
- `communication/store/database/index.ts`
- `communication/store/database/migrations.ts`
- `communication/store/database/schema.ts`
- `communication/store/database/values.ts`
- `communication/store/firewall.ts`
- `communication/store/inbox.ts`
- `communication/store/index.ts`
- `communication/store/queues/deliveries.ts`
- `communication/store/queues/dissemination.ts`
- `communication/store/queues/index.ts`
- `communication/store/queues/outbound.ts`
- `communication/store/queues/README.md`
- `communication/store/README.md`
- `communication/store/reads.ts`
- `communication/store/records.ts`
- `communication/store/rows/index.ts`
- `communication/store/rows/proposals.ts`
- `communication/store/rows/reanchors.ts`
- `communication/store/rows/records.ts`
- `communication/store/runtime-codec.ts`
- `communication/store/store.ts`
- `communication/store/types.ts`
- `daemon/bootstrap.ts`
- `daemon/configuration.ts`
- `daemon/credentials.ts`
- `daemon/errors.ts`
- `daemon/index.ts`
- `daemon/launcher/configuration.ts`
- `daemon/launcher/errors.ts`
- `daemon/launcher/index.ts`
- `daemon/launcher/installation.ts`
- `daemon/launcher/integrity.ts`
- `daemon/launcher/npm.ts`
- `daemon/launcher/packed-manifest.ts`
- `daemon/launcher/prepare.ts`
- `daemon/launcher/provenance.ts`
- `daemon/launcher/README.md`
- `daemon/launcher/selection.ts`
- `daemon/lifecycle.ts`
- `daemon/management/index.ts`
- `daemon/README.md`
- `daemon/registration/binding.ts`
- `daemon/registration/index.ts`
- `daemon/registration/README.md`
- `daemon/runtime/index.ts`
- `daemon/runtime/protocol.ts`
- `daemon/runtime/README.md`
- `daemon/telemetry.ts`
- `encoding/canonical-json.ts`
- `encoding/exact.ts`
- `encoding/identifier.ts`
- `environment.ts`
- `firewall/admission/admission.ts`
- `firewall/admission/firewall-checks.ts`
- `firewall/admission/firewall-results.ts`
- `firewall/admission/firewall-values.ts`
- `firewall/admission/firewall.ts`
- `firewall/admission/index.ts`
- `firewall/admission/README.md`
- `firewall/evaluator/chain.ts`
- `firewall/evaluator/contract/index.ts`
- `firewall/evaluator/decision.ts`
- `firewall/evaluator/english.ts`
- `firewall/evaluator/index.ts`
- `firewall/evaluator/jev.ts`
- `firewall/evaluator/questions.ts`
- `firewall/evaluator/README.md`
- `firewall/index.ts`
- `firewall/outcome/index.ts`
- `firewall/outcome/README.md`
- `firewall/policy/compose.ts`
- `firewall/policy/configuration.ts`
- `firewall/policy/document/index.ts`
- `firewall/policy/editable.ts`
- `firewall/policy/index.ts`
- `firewall/policy/load.ts`
- `firewall/policy/README.md`
- `firewall/README.md`
- `firewall/rules/builtin.ts`
- `firewall/rules/collective-norms.ts`
- `firewall/rules/index.ts`
- `firewall/rules/outcome.ts`
- `firewall/rules/README.md`
- `harness/endpoint/capability.ts`
- `harness/endpoint/events.ts`
- `harness/endpoint/index.ts`
- `harness/endpoint/README.md`
- `harness/inbox/history-export.ts`
- `harness/inbox/host-delivery.ts`
- `harness/inbox/inbox.ts`
- `harness/inbox/index.ts`
- `harness/inbox/pass.ts`
- `harness/inbox/README.md`
- `harness/mcp/auth.ts`
- `harness/mcp/event-signing.ts`
- `harness/mcp/events.ts`
- `harness/mcp/http.ts`
- `harness/mcp/index.ts`
- `harness/mcp/README.md`
- `harness/mcp/tools.ts`
- `harness/mcp/webhook.ts`
- `harness/protocol/event-schemas.ts`
- `harness/protocol/index.ts`
- `harness/protocol/names.ts`
- `harness/protocol/operations.ts`
- `harness/protocol/owner-tools.ts`
- `harness/protocol/README.md`
- `harness/protocol/schemas.ts`
- `harness/README.md`
- `identity/agents.ts`
- `identity/bounded-cache.ts`
- `identity/card-signing.ts`
- `identity/cards.ts`
- `identity/index.ts`
- `identity/keys.ts`
- `identity/registry/client.ts`
- `identity/registry/contract.ts`
- `identity/registry/index.ts`
- `identity/signing/http-errors.ts`
- `identity/signing/http-signature.ts`
- `identity/signing/registered/index.ts`
- `identity/wire-version.ts`
- `index.ts`
- `internal.ts`
- `README.md`
- `release/index.ts`
- `release/README.md`
- `test.ts`
