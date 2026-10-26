# client/firewall/policy/document

_`packages/client/src/firewall/policy/document`_

## Purpose

The message-policy document `sharnessd` installs as its firewall.

## Public surface

### [`decodeMessagePolicy`](./index.ts#L177)

_Variable_

```ts
export const decodeMessagePolicy = Schema.decodeUnknown(
  Schema.parseJson(MessagePolicy),
  { onExcessProperty: "error" },
)
```

Decodes the text of a message-policy document, refusing any property it
does not name, so a misspelled or newer setting never silently weakens the
policy.

### [`MessagePolicy`](./index.ts#L168)

_TypeAlias_

```ts
export type MessagePolicy = typeof MessagePolicy.Type;
```

One decoded message-policy document, with Client's defaults filled in.

### [`MessagePolicy`](./index.ts#L144)

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

## Files

- `index.ts`
