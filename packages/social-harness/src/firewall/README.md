# Message firewall

The firewall checks incoming messages and outgoing drafts against configured
rules. It returns a judgment and registered advice, and manages authorized
changes to editable rules.

This is an interface draft for review. The declarations below propose the next
boundary. Runtime code remains unchanged by this draft.

## Responsibilities

| Input | Output |
| --- | --- |
| Message, verified participants and permitted history | A judgment and advice restricted to visible evidence |
| Initial rules and previously saved editable rules | One active policy |
| Rule change and approval | A complete saved replacement, or a refusal preserving the old policy |

The daemon prepares conversation evidence and decides when to send or deliver.
The store saves rules and check records. A check uses one policy and one input
throughout its assessment.

## Checking a message

```mermaid
flowchart LR
  A[Message and permitted evidence] --> B[Capture input and active policy]
  B --> D[Run code checks]
  D --> E[Assess text rules]
  E --> F[Combine findings and select advice]
  F --> G[Return judgment and check record]
```

Text assessment asks whether rules apply, what response is expected, and whether
the message complies. Outgoing response expectations use earlier evidence
without the draft. Advice selects registered instructions and references the
host may see.

## Changing rules

```mermaid
flowchart LR
  A[Requested rule change] --> B[Validate complete replacement]
  B --> C[Approval placeholder approves]
  C --> D[Save replacement and change record]
  D --> E[Replace active policy]
```

A failed save leaves the old policy active. In-flight checks keep their policy.

## Proposed exports

`makeFirewall` obtains the shared `SqlClient` from the Effect environment.
The daemon provides its SQLite layer at startup. `checkMessage` remains the
test-only evaluator. Rule, message, provider and result types retain their
owning schemas.

```typescript
/**
 * Checks messages and manages the rules used by later checks.
 * Each operation captures one policy. A batch keeps that policy for all inputs.
 */
export interface Firewall {
  /** Fixed mode, owner facts and history/concurrency limits for this process. */
  readonly configuration: FirewallConfiguration;

  /** Returns fixed and editable rules with their current revision and source. */
  readPolicy(): Effect.Effect<PolicyRead, FirewallPolicyError>;

  /**
   * Saves and activates the complete authorized change before returning.
   * Failure preserves the previous policy and its change history.
   */
  updatePolicy(
    change: PolicyUpdate,
  ): Effect.Effect<PolicyUpdateResult, FirewallPolicyError>;

  /**
   * Checks all inputs under one policy and returns results in input order.
   * The caller saves completed decisions with the messages they permit.
   * Cancellation creates no completed decision.
   */
  check(
    inputs: readonly CheckInput[],
  ): Effect.Effect<readonly CheckedMessage[], CheckInputError>;
}

/**
 * Loads saved editable rules, or validates and saves initial rules when absent.
 * Provider resources and check capacity are shared across later rule edits.
 */
export declare function makeFirewall(
  configuration: FirewallOptions | LoadedMessagePolicy,
): Effect.Effect<Firewall, FirewallPolicyError, SqlClient.SqlClient>;
```

`CheckInput` contains direction, the exact candidate bytes, its message,
verified participant views and permitted context. A missing message records
an unavailable check. `CheckedMessage` contains the judgment, permitted
guidance and a completion record. The caller saves that completion with the
message's delivery outcome. These are values, rather than live check handles.

A rule change is checked under the current policy. An approval step initially
approves every edit automatically. That step can later use host elicitation.
Fixed rules remain supplied by configuration.

## Persistence

The firewall uses the shared SQL client to load editable rules and save
approved changes. The daemon saves completed decisions with the messages they
permit. Interrupted checks leave their messages pending for recovery.
Daemon-generated results are saved as results, without synthetic firewall
checks. Decision-history reads belong to the stored history.

## Test-only evaluator

`checkMessage` moves to the package's existing test-only entry. It uses
supplied rules and evidence without storage or configuration reads.

```typescript
/**
 * Checks supplied rules and verified evidence with an injected provider.
 * This offline operation performs no storage writes or configuration reads.
 */
export declare function checkMessage(
  input: CheckMessageInput,
): Effect.Effect<FirewallCheck, CheckInputError>;
```
