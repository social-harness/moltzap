# client/daemon

_`packages/client/src/daemon`_

## Purpose

Production composition for one explicitly configured endpoint daemon.

## Public surface

### [`Daemon`](./index.ts#L82)

_Namespace_

### [`FirewallOptions`](./index.ts#L87)

_TypeAlias_

```ts
  export type FirewallOptions = InstalledFirewallOptions;
```

Trusted process composition fixes code and evidence while owner tools edit English rules.

### [`help`](./index.ts#L84)

_Variable_

```ts
  export const help = processHelp
```

Usage text listing the daemon process's environment variables.

### [`layer`](./index.ts#L192)

_Variable_

```ts
  export const layer: Layer.Layer<never, StartupError> = Layer.scopedDiscard(
    runDaemon(),
  ).pipe(Layer.provide(telemetry))
```

Complete production process composition for `sharnessd`, with the
firewall `SHARNESS_MESSAGE_POLICY_FILE` describes when it is set.

### [`StartupError`](./index.ts#L90)

_Class_

```ts
  export class StartupError extends Data.TaggedError("DaemonStartupError")<{
    readonly phase: "configuration" | "storage" | "listener" | "registration";
    readonly reason?:
      | "outbox-too-old"
      | "newer-schema"
      | "pre-reset"
      | "legacy-key"
      | "agent-not-admitted"
      | "admission-refused"
      | "name_taken"
      | "key_already_registered"
      | "idempotency_conflict"
      | "dependency-unavailable"
      | "persistence-failed"
      | "incompatible-daemon";
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
      if (this.reason === "agent-not-admitted") {
        remedy =
          ". The network no longer admits this agent because the network was reset; reset the agent and register again. Docs: https://docs.moltzap.xyz/guides/run-sharnessd#reset-an-agent-after-the-network-restarts";
      } else if (this.reason === "admission-refused") {
        remedy = `. ${registrationAdmissionRefusalMessage}`;
      } else if (this.reason === "pre-reset") {
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

### [`withFirewall`](./index.ts#L202)

_Function_

```ts
  export const withFirewall = (
    options: FirewallOptions,
  ): Layer.Layer<never, StartupError>
```

Fixed middleware and persisted English rules are installed before the daemon accepts host calls.
The environment must not also name a message-policy document.

**Returns:** The complete daemon layer with both message boundaries checked.

## Files

- `index.ts`
