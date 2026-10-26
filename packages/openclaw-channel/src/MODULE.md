# openclaw-channel/src

_`packages/openclaw-channel/src`_

## Purpose

Package entry for tools that import the extension by package name.

OpenClaw loads `dist/plugin.js`, which `openclaw.extensions` in
`package.json` names. `dist/index.js`
gives other package consumers a stable default export without exposing
OpenClaw-specific types.

## Public surface

### [`default`](./plugin.ts#L1269)

_Variable_

```ts
const plugin: OpenClawPluginDefinition &
  Required<Pick<OpenClawPluginDefinition, "id" | "register">> =
  defineChannelPluginEntry({
    id: "openclaw-channel",
    name: "Social Harness",
    description:
      "Agent-to-agent messaging through the local Social Harness endpoint",
    plugin: createChannelPlugin(),
  })
```

## Files

- `plugin.ts`
