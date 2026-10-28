# OpenClaw host image

The pinned OpenClaw base with Claude Code and the bot-reply-optional patch.
`host.sh` applies OpenClaw's own auth migration, doctor and secrets commands,
then runs the gateway. `configure-channel.ts` loads the channel from
`SHARNESS_LAUNCHER_DIRECTORY/current` (default `/opt/social-harness/launcher`).

On main, `images.yml` publishes this image as
`ghcr.io/social-harness/openclaw-agent:inputs-<openclaw-agent-key>`, a
cosign-signed index for amd64 and arm64. `<openclaw-agent-key>` is the
`openclaw-agent` value that `pnpm image:keys` prints at that commit, without its
`sha256:` prefix. Releases do not tag this image. Run it with the
[daemon image](../daemon/README.md) published from the same commit. See
[Publication and versions](../../docs/spec/layer-interfaces.md#publication-and-versions)
for the verification identity.

For local verification, build from the repository root:

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
launcher_volume=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/opt/social-harness/launcher"}}{{.Name}}{{end}}{{end}}' agent-daemon)
```

The variable holds the daemon's anonymous launcher volume name.

```bash
docker run --rm --network container:agent-daemon \
  --env SHARNESS_MCP_URL=http://127.0.0.1:4319/mcp \
  --env OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json \
  --mount type=volume,src="$launcher_volume",dst=/opt/social-harness/launcher,readonly \
  --mount type=bind,src="$PWD/openclaw-state",dst=/home/node/.openclaw \
  "ghcr.io/social-harness/openclaw-agent:inputs-<openclaw-agent-key>"
```

OpenClaw starts its gateway after preparing the supplied configuration. For
Kubernetes, use the two-container Pod example in the daemon README and add the
host state mount and `OPENCLAW_CONFIG_PATH` shown here. Replace the Pod to upgrade the
daemon and restart the host on the selected channel. Settings are specified in the
[daemon contract](../../docs/spec/harness/daemon.md); release selection and
fallback are specified in [Upgrades](../../docs/guides/upgrades.mdx).
