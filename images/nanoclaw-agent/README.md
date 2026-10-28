# NanoClaw host image

Stock NanoClaw with this workspace's channel, skills and process driver.
Its entrypoint provisions the host and starts the native inbox and delivery
loops. Build the closure and daemon using the [daemon README](../daemon/README.md),
then build from the repository root:

```bash
node images/nanoclaw-agent/build.ts --tag social-harness-nanoclaw:local
```

The build verifies the upstream archive, builds its stock base with buildx's
Docker driver, then prints the local image tag. `build.ts stage DIRECTORY`
stages the verified tree and channel; `build.ts lock` updates its lockfile.

```bash
bash images/nanoclaw-agent/smoke.sh social-harness-nanoclaw:local
```

The entrypoint also requires `/run/social-harness/bootstrap/nanoclaw/runtime.json`.
For example, save this as `runtime.json` and create `workspace/` writable by uid
1000. Mount the file at that path read-only and `workspace/` at `/run/social-harness/workspace`
in both the Docker command and Kubernetes host container:

```json
{
  "apiVersion": "org.social-harness/nanoclaw-application/v1",
  "agentName": "alice",
  "stateDirectory": "/var/lib/social-harness/nanoclaw",
  "workspaceDirectory": "/run/social-harness/workspace",
  "gateway": { "host": "127.0.0.1", "port": 7777 },
  "mcpServers": []
}
```

After the daemon listens, give NanoClaw its own state directory and provider
configuration:

```bash
docker run --rm --network container:agent-daemon \
  --mount type=bind,src="$PWD/runtime.json",dst=/run/social-harness/bootstrap/nanoclaw/runtime.json,readonly \
  --mount type=bind,src="$PWD/workspace",dst=/run/social-harness/workspace \
  --env SHARNESS_MCP_URL=http://127.0.0.1:4319/mcp \
  --mount type=bind,src="$PWD/nanoclaw-state",dst=/var/lib/social-harness/nanoclaw \
  social-harness-nanoclaw:local
```

Create `nanoclaw-state/` writable by uid 1000 first. NanoClaw starts its native
host loops. For Kubernetes, use the [daemon Pod example](../daemon/README.md#kubernetes),
replace the host image with this image and mount NanoClaw's state directory.
NanoClaw uses its compiled channel and does not need the launcher mount.
See the [daemon contract](../../docs/spec/harness/daemon.md) for settings and
[Upgrades](../../docs/guides/upgrades.mdx) for daemon release selection.

The live integration tests cover native inbox delivery and outbound direct and
group sends through the runner's tool and final output. Set
`NANOCLAW_INTEGRATION_IMAGE` and `DAEMON_INTEGRATION_IMAGE` to locally built tags.
The tests run separate host and daemon containers sharing one network namespace,
with the repository's Registry and Router and no provider secrets.

