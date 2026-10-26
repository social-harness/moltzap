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
interface. Use a fresh anonymous launcher volume for each daemon container.
Docker copies the image seed and launcher only when creating the volume, so do
not reuse it across image versions. Keep daemon state on its persistent mount.
Keep registration settings fixed for a signing key. Lost daemon state requires
a new signing key and a new registration OperationId.

```bash
docker run --detach --name agent-daemon \
  --env-file daemon.env \
  --env SHARNESS_LAUNCHER_UPGRADE=off \
  --mount type=bind,src="$PWD/daemon-secrets",dst=/run/sharness,readonly \
  --mount type=bind,src="$PWD/daemon-state",dst=/var/lib/sharness \
  --mount type=volume,dst=/opt/social-harness/launcher \
  social-harness-daemon:local
```

Wait for `sharnessd listening` in `docker logs agent-daemon`, then start the host
with `--network container:agent-daemon`; see the host README. Port `4319` is on
loopback in this shared namespace. Registry and Router origins must be reachable
from the daemon. This example runs the image release with upgrades off. To
upgrade, replace both containers with the newer image and a fresh launcher volume.

## Kubernetes

Use the daemon as a native sidecar (`restartPolicy: Always` under
`initContainers`). An exec startup probe connects to `127.0.0.1:4319`; a TCP probe
from the kubelet cannot reach a loopback-only listener. Kubernetes waits for the
startup probe before starting the host.

The following Pod template excerpt assumes a `daemon-settings` ConfigMap, a
`daemon-secrets` Secret and a `daemon-state` PersistentVolumeClaim. The ConfigMap
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
    - name: launcher-prepare
      image: social-harness-daemon:local
      args: ["prepare"]
      envFrom:
        - configMapRef: { name: daemon-settings }
      env:
        - { name: SHARNESS_LAUNCHER_UPGRADE, value: "on" }
      volumeMounts:
        - { name: launcher, mountPath: /opt/social-harness/launcher }
    - name: daemon
      image: social-harness-daemon:local
      restartPolicy: Always
      env:
        - { name: SHARNESS_LAUNCHER_UPGRADE, value: "off" }
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
    - name: state
      persistentVolumeClaim: { claimName: daemon-state }
    - name: daemon-secrets
      secret: { secretName: daemon-secrets }
```

The regular `launcher-prepare` init container upgrades once per Pod, before the
host loads its channel. The daemon sidecar keeps that release on restarts.
With startup registration configured, the probe passes after registration and
activation. With no registration settings, it can pass before registration.
Persist state for the lifetime of its signing key. Add the host's own writable
state and provider configuration.
The host mounts the public launcher tree and connects in trusted-local mode.
