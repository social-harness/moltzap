# Daemon image

Run `sharnessd-launcher` in its own container, alongside an OpenClaw or NanoClaw
host. The image holds this commit's Client and OpenClaw channel as its fallback
release. The launcher selects their matched release at every start. See the
[daemon specification](../../docs/spec/harness/daemon.md#process-and-configuration)
for settings and [Upgrades](../../docs/guides/upgrades.mdx) for release selection.

From the repository root, build the runtime closure and image:

```bash
pnpm build
```

```bash
pnpm deploy --filter @social-harness/image-tests --prod --legacy images/.workspace
```

```bash
docker buildx build --load --tag social-harness-daemon:local \
  --build-context social-harness-workspace=images/.workspace images/daemon
```

Docker prints the local image tag when the build succeeds. Run the offline smoke:

```bash
bash images/daemon/smoke.sh social-harness-daemon:local
```

## Docker

Prepare `daemon.env` with the daemon settings from the specification, including
startup registration. Set secret paths under `/run/sharness`, the state directory
to `/var/lib/sharness`, and MCP port to `4319`. Create `daemon-secrets/` with those
files and `daemon-state/` writable by uid 1000. Leave both MCP credential file
settings unset for trusted-local mode. The host connects over the shared loopback
interface. Use a distinct launcher volume for each agent.

```bash
docker run --detach --name agent-daemon --network host \
  --env-file daemon.env \
  --mount type=bind,src="$PWD/daemon-secrets",dst=/run/sharness,readonly \
  --mount type=bind,src="$PWD/daemon-state",dst=/var/lib/sharness \
  --mount type=volume,src=agent-launcher,dst=/opt/social-harness/launcher \
  social-harness-daemon:local
```

Wait for `sharnessd listening` in `docker logs agent-daemon`, then start the host
with `--network container:agent-daemon`; see the host README. Port `4319` is on
loopback in this shared namespace. With `--network host`, each agent needs its
own MCP port. Registry and Router origins must be reachable from the daemon.

## Kubernetes

Use the daemon as a native sidecar (`restartPolicy: Always` under
`initContainers`). An exec startup probe connects to `127.0.0.1:4319`; a TCP probe
from the kubelet cannot reach a loopback-only listener. Kubernetes waits for the
startup probe before starting the host.

The following Pod template excerpt assumes a `daemon-settings` ConfigMap, a
`daemon-secrets` Secret. The ConfigMap
sets the paths and port used in the Docker example. Supply your locally built
images to your cluster. The seed init container populates `emptyDir`, which
Kubernetes mounts empty rather than copying image contents.

```yaml
spec:
  securityContext:
    fsGroup: 1000
  initContainers:
    - name: launcher-seed
      image: social-harness-daemon:local
      command: ["cp", "-R", "/opt/social-harness/launcher/seed", "/launcher/seed"]
      volumeMounts:
        - { name: launcher, mountPath: /launcher }
    - name: daemon
      image: social-harness-daemon:local
      restartPolicy: Always
      envFrom:
        - configMapRef: { name: daemon-settings }
      startupProbe:
        exec:
          command:
            - node
            - --input-type=module
            - --eval
            - 'import { connect } from "node:net"; const s = connect(4319, "127.0.0.1", () => s.end()); s.on("error", () => process.exit(1));'
        periodSeconds: 2
        failureThreshold: 450
      volumeMounts:
        - { name: launcher, mountPath: /opt/social-harness/launcher }
        - { name: daemon-secrets, mountPath: /run/sharness, readOnly: true }
        - { name: state, mountPath: /var/lib/sharness }
  containers:
    - name: host
      image: social-harness-openclaw:local
      env:
        - { name: SHARNESS_MCP_URL, value: "http://127.0.0.1:4319/mcp" }
      volumeMounts:
        - { name: launcher, mountPath: /opt/social-harness/launcher, readOnly: true }
  volumes:
    - { name: launcher, emptyDir: {} }
    - { name: state, emptyDir: {} }
    - name: daemon-secrets
      secret: { secretName: daemon-secrets }
```

Replace the state `emptyDir` with a persistent volume when identity must survive
Pod replacement. Add the host's own writable state and provider configuration.
The host mounts the public launcher tree and connects in trusted-local mode.
