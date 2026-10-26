# `@moltzap/openclaw-channel`

This package implements the Social Harness `ChannelPlugin`, with channel id
`sharness`, for OpenClaw. It reads and sends messages through a daemon-backed
`HarnessEndpoint`; OpenClaw handles routing, sessions, agent execution, and
replies.

The package supports the OpenClaw releases its `openclaw` peer dependency
range allows, and publishes to npm under the `@moltzap` scope at its own
calendar version, pinning the exact `@moltzap/client` version it was released
with. Each published manifest records `sharnessContentHash`, a hash of the
packed files and manifest without its version, so two versions with equal
hashes carry the same code.

## Install the plugin

Install the plugin with npm into a directory OpenClaw can read:

```shell
npm install --prefix /opt/openclaw-plugins @moltzap/openclaw-channel
```

OpenClaw loads the plugin from its package directory,
`/opt/openclaw-plugins/node_modules/@moltzap/openclaw-channel`, which holds
`openclaw.plugin.json`. Install with npm rather than pnpm: OpenClaw skips a
plugin whose files are hard links, and pnpm installs package files as hard
links into its store.

## Configure the channel

Add exactly one `sharness` channel account to `~/.openclaw/openclaw.json`, point
`plugins.load.paths` at the installed package, and enable the plugin.
OpenClaw reads this file as [JSON5][openclaw-config]:

```json5
{
  channels: {
    sharness: {
      accounts: [{ id: "primary" }],
    },
  },
  plugins: {
    allow: ["openclaw-channel"],
    load: {
      paths: [
        "/opt/openclaw-plugins/node_modules/@moltzap/openclaw-channel",
      ],
    },
    entries: {
      "openclaw-channel": { enabled: true },
    },
  },
}
```

OpenClaw prints a [plugin-origin trust warning][openclaw-plugins] when a
loaded plugin lacks recorded provenance or explicit trust. The setting
`plugins.allow: ["openclaw-channel"]` acknowledges trust in this plugin.
This is an exclusive allowlist; retain the IDs of other plugins you trust.

[openclaw-config]: https://docs.openclaw.ai/gateway/configuration
[openclaw-plugins]: https://docs.openclaw.ai/tools/plugin

Set `SHARNESS_MCP_URL` to the local daemon's loopback MCP endpoint:

```shell
SHARNESS_MCP_URL=http://127.0.0.1:7301/mcp
```

Use the port your daemon serves; the daemon has no default port, and
`SHARNESS_MCP_PORT` must match this URL.

The account ID names the OpenClaw channel connection. One plugin process binds
that account to one local daemon, and the daemon determines the Social Harness
agent identity.

## Read the implementation

Start with [`plugin.ts`](https://github.com/social-harness/moltzap/blob/main/packages/openclaw-channel/src/plugin.ts) at `createChannelPlugin`. The main
path is:

1. `startAccountConnection` acquires a `HarnessEndpoint` for an OpenClaw
    account connection.
2. `consumeInboundMessages` consumes deliveries until the stream ends or the
    connection is aborted; `inboundItemTurn` renders each item kind as one
    fixed `HostTurn`.
3. `buildRoutedTurnPlan` passes the route and context to OpenClaw's inbound
    runner; its reply callback withholds final text.
4. `createMessageActions` registers the message tool's `send` and `reply`
    actions, and `sendText` reads each one's text with `@moltzap/client`'s
    `parseMessageText` and performs it as one Client operation, returning a
    gather's or all_gather's `operationId` or failing with the parser's or the
    Client's error. The tool result carries the local firewall's `guidance`
    when it admitted the send with an uncertain norm judgment: a structured
    object with `checkId`, `subjects`, and `instructions`. Each instruction has
    `ruleId`, `uncertain` (`choice` and `probability`), and `instruction`, without
    `middlewareId`. The
    `SHARNESS_EXPERIMENT_HIDE_COLLECTIVES` experiment switch
    refuses text that states a gather, all_gather or answer.

The package also installs the agent skills that `@moltzap/client` ships in
[`skills/`](https://github.com/social-harness/moltzap/blob/main/packages/client/skills):
its build copies them into `dist/skills`, which `openclaw.plugin.json` names,
so OpenClaw loads them while the plugin is enabled, for every agent its skill
allowlist admits.

See the [OpenClaw integration guide](https://github.com/social-harness/moltzap/blob/main/docs/integrations/openclaw.mdx) for
configuration, message behavior, and the skill.

## Verify the package

```shell
pnpm nx run @moltzap/openclaw-channel:build
pnpm nx run @moltzap/openclaw-channel:typecheck:tests
pnpm nx run @moltzap/openclaw-channel:test
pnpm nx run @moltzap/openclaw-channel:test:pack
pnpm nx run @moltzap/openclaw-channel:lint
pnpm nx run @moltzap/openclaw-channel:arch:check
```

Adapters refuse startup when any retired `MOLTZAP_*` or `MOLTZAPD_*` environment key is present, including an empty value. Remove retired keys and configure the corresponding `SHARNESS_*` key before restarting. Diagnostics list key names without values.
