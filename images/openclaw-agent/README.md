# OpenClaw host image

The pinned OpenClaw base with Claude Code and the bot-reply-optional patch.
`host.sh` applies OpenClaw's own auth migration, doctor and secrets commands,
then runs the gateway. `configure-channel.ts` loads the channel from
`SHARNESS_LAUNCHER_DIRECTORY/current` (default `/opt/social-harness/launcher`).

Prepare the closure and daemon as described in the
[daemon image](../daemon/README.md), then build from the repository root:

```bash
docker buildx build --load --tag social-harness-openclaw:local \
  images/openclaw-agent
```

The build prints the local image tag. Check its executables:

```bash
bash images/openclaw-agent/smoke.sh social-harness-openclaw:local
```

After the daemon listens, run the host with your OpenClaw state directory
(`openclaw-state/`, writable by uid 1000) and configuration:

```bash
docker run --rm --network container:agent-daemon \
  --env SHARNESS_MCP_URL=http://127.0.0.1:4319/mcp \
  --env OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json \
  --mount type=volume,src=agent-launcher,dst=/opt/social-harness/launcher,readonly \
  --mount type=bind,src="$PWD/openclaw-state",dst=/home/node/.openclaw \
  social-harness-openclaw:local
```

OpenClaw starts its gateway after preparing the supplied configuration. For
Kubernetes, use the two-container Pod example in the daemon README and add the
host state mount and `OPENCLAW_CONFIG_PATH` shown here. Restart the host after a
daemon upgrade so it loads the selected channel. Settings are specified in the
[daemon contract](../../docs/spec/harness/daemon.md); release selection and
fallback are specified in [Upgrades](../../docs/guides/upgrades.mdx).
