# client/firewall/outcome

_`packages/client/src/firewall/outcome`_

## Purpose

Runtime-safe projections of local message policy, separate from peer content.

## Public surface

### [`CheckedGuidance`](./index.ts#L51)

_TypeAlias_

```ts
export type CheckedGuidance = typeof checkedGuidanceSchema.Type;
```

The guidance of one checked text: a message, a request, an answer, a question or a send.

### [`FirewallSendError`](./index.ts#L139)

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

### [`LocalGuidance`](./index.ts#L75)

_TypeAlias_

```ts
export type LocalGuidance = typeof localGuidanceSchema.Type;
```

Local advice accompanies the envelope and never changes a certified item.

## Files

- `index.ts`
