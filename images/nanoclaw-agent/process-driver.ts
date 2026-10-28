/**
 * @file In-process NanoClaw session driver for the complete agent image. The
 * image is already the isolation boundary, so the driver runs the one agent
 * session as a child process group of the host instead of a nested container,
 * and realizes the session's mounts as symbolic links.
 */
import type { Stats } from "node:fs";
import { type ChildProcess, spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  readdir,
  readlink,
  realpath,
  rmdir,
  symlink,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** The driver kind NanoClaw's runtime registry selects this driver by. */
export const PROCESS_DRIVER_KIND = "moltzap-process";

/**
 * Claude Code's telemetry and content switches and the OTLP exporter's
 * settings, which hosting sets for an agent with a telemetry origin. The
 * agent is Claude Code under the Agent SDK, which passes them on, so it
 * exports whenever the host's environment carries them.
 */
export const AGENT_TELEMETRY_VARIABLES = Object.freeze([
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA",
  "OTEL_BLRP_MAX_QUEUE_SIZE",
  "OTEL_BSP_MAX_QUEUE_SIZE",
  "OTEL_BSP_SCHEDULE_DELAY",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_LOG_ASSISTANT_RESPONSES",
  "OTEL_LOG_TOOL_CONTENT",
  "OTEL_LOG_TOOL_DETAILS",
  "OTEL_LOG_USER_PROMPTS",
  "OTEL_LOGS_EXPORTER",
  "OTEL_LOGS_EXPORT_INTERVAL",
  "OTEL_METRIC_EXPORT_INTERVAL",
  "OTEL_METRICS_EXPORTER",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_TRACES_EXPORTER",
  "OTEL_TRACES_EXPORT_INTERVAL",
]);

/**
 * The variables Claude Code under the Agent SDK signs in with, forwarded
 * whenever the host's environment carries them. Which one a run uses is the
 * run's choice, made by the credentials its application declares; Claude
 * Code prefers an API key to a token when it sees both.
 */
export const AGENT_CREDENTIAL_VARIABLES = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);

/**
 * The HTTPS proxy a provider gateway serves Claude Code through and the
 * authority that proxy signs the provider's host with, forwarded whenever
 * the host's environment carries them. Both spellings are kept, because the
 * tools Claude Code runs read the lowercase ones.
 */
export const AGENT_PROXY_VARIABLES = Object.freeze([
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
]);

const CAPABILITIES: DriverCapabilities = Object.freeze({
  isolationTiers: Object.freeze(["container" as const]),
  admissionEnforced: false,
  networkPolicy: "topology",
  encryptedVolumes: false,
  unrealized: Object.freeze(["memoryMb", "cpus", "pidsLimit", "shmSizeMb"]),
  sharedNetworkNamespace: true,
  auxiliaryContainers: false,
  imageBuild: false,
});
const DEFAULT_WORKING_DIRECTORY = "/workspace/agent";
const DEFAULT_STATE_DIRECTORY = "/var/lib/moltzap/nanoclaw";
/** How long a process group has to exit after `SIGKILL`. */
const KILL_WAIT_MILLIS = 1_000;
/** How often a stop checks whether the agent's process group is gone. */
const GROUP_POLL_MILLIS = 25;

/** NanoClaw's identity of one session: install, agent group and session. */
export interface SessionKey {
  readonly installSlug: string;
  readonly agentGroupId: string;
  readonly sessionId: string;
}

/** The parts of one NanoClaw mount the driver realizes as a link. */
export interface MountSpec {
  readonly hostPath: string;
  readonly containerPath: string;
}

/** The parts of NanoClaw's container specification the driver runs. */
export interface ContainerSpec {
  readonly role: string;
  readonly env: Readonly<Record<string, string>>;
  readonly contributedEnv?: Readonly<Record<string, string>>;
  readonly command?: readonly string[];
  readonly args?: readonly string[];
  readonly mounts: readonly MountSpec[];
}

/** The parts of NanoClaw's session specification the driver reads. */
export interface SessionSpec {
  readonly key: SessionKey;
  readonly containers: readonly ContainerSpec[];
  readonly runAs?: { readonly uid: number; readonly gid: number };
  readonly stopGraceSeconds: number;
}

/** Why a session failed, in NanoClaw's failure vocabulary. */
export type SessionFailure =
  | {
      readonly kind: "spec-invalid";
      readonly retryable: false;
      readonly detail: string;
    }
  | {
      readonly kind: "started-then-died";
      readonly retryable: false;
      readonly exitCode?: number;
    }
  | {
      readonly kind: "unknown";
      readonly retryable: false;
      readonly opaqueRef: string;
    };

/** A session's lifecycle state as NanoClaw's host reads it. */
export type SessionStatus =
  | { readonly phase: "preparing" }
  | { readonly phase: "ready" }
  | { readonly phase: "running" }
  | { readonly phase: "stopped" }
  | { readonly phase: "failed"; readonly failure: SessionFailure };

/** A change NanoClaw's host is told about; `terminal` ends the session. */
export interface SessionEvent {
  readonly key: SessionKey;
  readonly kind: "phase" | "terminal";
}

/** The host's control over one prepared session. */
export interface SessionHandle {
  readonly key: SessionKey;
  readonly name: string;
  start(): Promise<undefined>;
  status(): Promise<SessionStatus>;
  stop(): Promise<undefined>;
  execSpec(): never;
}

/** One session as `listSessions` reports it. */
export interface SessionSnapshot {
  readonly handle: SessionHandle;
  readonly phase: "starting" | "running" | "terminal";
  readonly failure?: SessionFailure;
}

/** What the driver can realize of a session specification. */
export interface DriverCapabilities {
  readonly isolationTiers: ReadonlyArray<"container">;
  readonly admissionEnforced: boolean;
  readonly networkPolicy: "topology";
  readonly encryptedVolumes: boolean;
  readonly unrealized: readonly string[];
  readonly sharedNetworkNamespace: boolean;
  readonly auxiliaryContainers: boolean;
  readonly imageBuild: boolean;
}

/** The session driver contract NanoClaw's runtime registry accepts. */
export interface SessionDriver {
  readonly kind: string;
  capabilities(): DriverCapabilities;
  ensureReady(): Promise<undefined>;
  prepare(spec: SessionSpec): Promise<SessionHandle>;
  listSessions(installSlug: string): Promise<readonly SessionSnapshot[]>;
  watchSessions(
    installSlug: string,
    onEvent: (event: SessionEvent) => void,
  ): SessionWatch;
}

/** Ends one `watchSessions` subscription. */
export interface SessionWatch {
  stop(): void;
}

/**
 * NanoClaw's own validation of a specification against the host's mount
 * policy, which the driver passes through without reading.
 */
export type ValidateSpec = (
  spec: SessionSpec,
  policy: unknown,
  capabilities: DriverCapabilities,
) => void;

/** NanoClaw's constructor for the `spec-invalid` failure the driver throws. */
export type SpecInvalid = (detail: string) => Error;

/** Where the driver projects container paths and how it reports refusals. */
export interface MountOptions {
  readonly resolveContainerPath?: (path: string) => string;
  readonly specInvalid?: SpecInvalid;
}

/**
 * NanoClaw's `onHostShutdown`: the host's graceful shutdown awaits each
 * registered callback before it tears down its channels and exits.
 */
export type OnHostShutdown = (stop: () => Promise<undefined>) => void;

/**
 * The driver's collaborators. `resolveContainerPath` maps a path inside the
 * session's notional container to the outer container's file system,
 * `workingDirectory` is the agent's container working directory, and
 * `baseEnvironment` replaces the agent's inherited environment, which by
 * default carries only the host's Claude Code sign-in variables, telemetry
 * settings and provider proxy, `HOME`, `NODE_ENV`, `PATH` and `TMPDIR`.
 */
export interface ProcessDriverOptions {
  readonly policy: unknown;
  readonly validateSpec: ValidateSpec;
  readonly specInvalid: SpecInvalid;
  readonly onHostShutdown: OnHostShutdown;
  readonly resolveContainerPath?: (path: string) => string;
  readonly workingDirectory?: string;
  readonly baseEnvironment?: Readonly<Record<string, string>>;
}

/** The NanoClaw seams `installProcessSessionDriver` uses. */
export interface ProcessDriverDependencies {
  readonly registerSessionDriver: (
    kind: string,
    factory: (policy: unknown) => SessionDriver,
  ) => void;
  readonly onHostShutdown: OnHostShutdown;
  readonly validateSpec: ValidateSpec;
  readonly specInvalid: SpecInvalid;
}

interface DriverSettings {
  readonly policy: unknown;
  readonly validateSpec: ValidateSpec;
  readonly specInvalid: SpecInvalid;
  readonly resolveContainerPath: (path: string) => string;
  readonly workingDirectory: string;
  readonly baseEnvironment: Readonly<Record<string, string>>;
}

interface SessionRecord {
  readonly spec: SessionSpec;
  child?: ChildProcess;
  stopping: boolean;
  status: SessionStatus;
}

interface Session {
  readonly record: SessionRecord;
  readonly ready: Promise<undefined>;
  readonly handle: SessionHandle;
}

/**
 * The driver's mutable state: the one key the container is bound to, the
 * latest session, the host's watchers, and the stop the host's shutdown
 * started.
 */
interface DriverState {
  readonly settings: DriverSettings;
  readonly watchers: Map<symbol, (event: SessionEvent) => void>;
  boundKey?: SessionKey;
  current?: Session;
  hostShutdown?: Promise<undefined>;
}

/**
 * Project a validated container mount list into the already-isolated outer
 * application container. The shallowest target is linked first so nested
 * mounts are resolved inside the selected session workspace.
 */
export async function materializeProcessMounts(
  mounts: readonly MountSpec[],
  options: MountOptions = {},
): Promise<undefined> {
  const resolveContainerPath =
    options.resolveContainerPath ?? ((path: string) => path);
  const specInvalid =
    options.specInvalid ?? ((detail: string) => new Error(detail));
  const ordered = [...mounts].sort(
    (left, right) => left.containerPath.length - right.containerPath.length,
  );
  for (const mount of ordered) {
    const target = resolveContainerPath(mount.containerPath);
    if (!isAbsolute(target)) {
      throw specInvalid(
        `process-driver resolved a relative mount target: ${target}`,
      );
    }
    await replaceWithSymlink(target, mount.hostPath, specInvalid);
  }
}

/**
 * Create the single-session process realization used inside one app pod.
 * The first prepared key binds the container; preparing another key fails.
 * The driver registers its stop with the host's shutdown, after which
 * preparing any session fails.
 */
export function createProcessSessionDriver(
  options: ProcessDriverOptions,
): SessionDriver {
  const state: DriverState = {
    settings: {
      policy: options.policy,
      validateSpec: options.validateSpec,
      specInvalid: options.specInvalid,
      resolveContainerPath:
        options.resolveContainerPath ?? ((path: string) => path),
      workingDirectory: options.workingDirectory ?? DEFAULT_WORKING_DIRECTORY,
      baseEnvironment: options.baseEnvironment ?? defaultBaseEnvironment(),
    },
    watchers: new Map(),
  };
  options.onHostShutdown(() => stopWithHost(state));
  return Object.freeze({
    kind: PROCESS_DRIVER_KIND,
    capabilities: () => CAPABILITIES,
    ensureReady: () => Promise.resolve(undefined),
    prepare: (spec: SessionSpec) => prepareSession(state, spec),
    listSessions: (installSlug: string) =>
      Promise.resolve(sessionSnapshots(state, installSlug)),
    watchSessions: (
      installSlug: string,
      onEvent: (event: SessionEvent) => void,
    ) => watchSessions(state, installSlug, onEvent),
  });
}

/**
 * Register the process driver through NanoClaw's public driver seam. The
 * session's `/workspace` and its session-context file resolve under the
 * state directory `DEPLOYMENT_NANOCLAW_STATE` names.
 */
export function installProcessSessionDriver(
  dependencies: ProcessDriverDependencies,
): void {
  const resolveContainerPath = containerPathResolver(
    process.env.DEPLOYMENT_NANOCLAW_STATE ?? DEFAULT_STATE_DIRECTORY,
  );
  dependencies.registerSessionDriver(PROCESS_DRIVER_KIND, (policy) =>
    createProcessSessionDriver({
      policy,
      validateSpec: dependencies.validateSpec,
      specInvalid: dependencies.specInvalid,
      onHostShutdown: dependencies.onHostShutdown,
      resolveContainerPath,
    }),
  );
}

function containerPathResolver(
  stateDirectory: string,
): (path: string) => string {
  return (path) => {
    if (path === "/workspace") {
      return `${stateDirectory}/current-workspace`;
    }
    if (path === "/app/.nanoclaw-session.json") {
      return `${stateDirectory}/current-session-context`;
    }
    return path;
  };
}

function defaultBaseEnvironment(): Readonly<Record<string, string>> {
  return {
    ...Object.fromEntries(
      [
        ...AGENT_CREDENTIAL_VARIABLES,
        ...AGENT_TELEMETRY_VARIABLES,
        ...AGENT_PROXY_VARIABLES,
      ].flatMap(
        (name) => {
          const value = process.env[name];
          return value === undefined ? [] : [[name, value]];
        },
      ),
    ),
    HOME: "/home/node",
    NODE_ENV: "production",
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    // eslint-disable-next-line sonarjs/publicly-writable-directories -- the agent's scratch default, as in NanoClaw's stock agent container.
    TMPDIR: process.env.TMPDIR ?? "/tmp",
  };
}

/**
 * Validate `spec`, bind the container to its key, and return the live
 * session for that key or prepare a new one once the last has ended. Once
 * the host's shutdown has begun, nothing is prepared.
 */
async function prepareSession(
  state: DriverState,
  spec: SessionSpec,
): Promise<SessionHandle> {
  const { settings } = state;
  if (state.hostShutdown !== undefined) {
    throw new Error("the NanoClaw host is shutting down and starts no session");
  }
  settings.validateSpec(spec, settings.policy, CAPABILITIES);
  const [agent] = spec.containers;
  if (spec.containers.length !== 1 || agent?.role !== "agent") {
    throw settings.specInvalid(
      "process driver accepts exactly one agent container and no auxiliaries",
    );
  }
  bindKey(state, spec.key);
  const live = liveSession(state, spec.key);
  if (live !== undefined) {
    await live.ready;
    return live.handle;
  }
  const record: SessionRecord = {
    spec,
    stopping: false,
    status: { phase: "preparing" },
  };
  const ready = materializeRecord(state, record, agent.mounts);
  const handle = makeHandle(state, record, ready);
  state.current = { record, ready, handle };
  await ready;
  return handle;
}

/**
 * Stop the live session once when the host shuts down. NanoClaw leaves sessions
 * for a later host to adopt, while this container owns the session's lifetime.
 * The container's termination grace must cover the session's stopGraceSeconds and KILL_WAIT_MILLIS.
 */
function stopWithHost(state: DriverState): Promise<undefined> {
  state.hostShutdown ??= stopLiveSession(state);
  return state.hostShutdown;
}

async function stopLiveSession(state: DriverState): Promise<undefined> {
  const live =
    state.boundKey === undefined
      ? undefined
      : liveSession(state, state.boundKey);
  await live?.handle.stop();
}

function liveSession(state: DriverState, key: SessionKey): Session | undefined {
  const { current } = state;
  if (current === undefined || !sameKey(current.record.spec.key, key)) {
    return undefined;
  }
  const { phase } = current.record.status;
  return phase === "stopped" || phase === "failed" ? undefined : current;
}

function makeHandle(
  state: DriverState,
  record: SessionRecord,
  ready: Promise<undefined>,
): SessionHandle {
  return Object.freeze({
    key: record.spec.key,
    name: `moltzap-process-${record.spec.key.agentGroupId}`,
    start: () => startSession(state, record, ready),
    status: () => sessionStatus(record, ready),
    stop: () => stopSession(state, record, ready),
    execSpec: () => {
      throw state.settings.specInvalid(
        "interactive attach is unavailable in the NanoClaw image process driver",
      );
    },
  });
}

/**
 * Start the agent from a ready session in its own process group, so `stop`
 * reaches every process the agent starts in that group. A process that
 * starts a session of its own, as Claude Code does for each shell command,
 * leaves the group, and `stop` does not reach it. The agent's output reaches
 * the host's through pipes the host reads, so no agent process holds the
 * host's own output open after the host exits, however it exits.
 */
async function startSession(
  state: DriverState,
  record: SessionRecord,
  ready: Promise<undefined>,
): Promise<undefined> {
  await ready;
  if (record.status.phase === "running") {
    return;
  }
  if (record.status.phase !== "ready") {
    throw state.settings.specInvalid(
      `cannot start ${keyText(record.spec.key)} from ${record.status.phase}`,
    );
  }
  const child = spawnAgent(state.settings, record.spec);
  record.child = child;
  record.status = { phase: "running" };
  emit(state, "phase");
  child.once("error", (error) => {
    recordAgentError(state, record, error);
  });
  child.once("exit", (exitCode) => {
    recordAgentExit(state, record, exitCode);
  });
}

/**
 * Spawn the agent's command. A spawn that fails, for example when the host
 * is out of file descriptors, has no pid and no pipes; its `error` event
 * fails the session.
 */
function spawnAgent(settings: DriverSettings, spec: SessionSpec): ChildProcess {
  const [agent] = spec.containers;
  const [executable, ...commandArgs] = agent?.command ?? [];
  if (agent === undefined || executable === undefined) {
    throw settings.specInvalid("agent container has no command");
  }
  const child = spawn(executable, [...commandArgs, ...(agent.args ?? [])], {
    cwd: settings.resolveContainerPath(settings.workingDirectory),
    detached: true,
    env: {
      ...settings.baseEnvironment,
      ...agent.env,
      ...agent.contributedEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
    ...(spec.runAs === undefined
      ? {}
      : { uid: spec.runAs.uid, gid: spec.runAs.gid }),
  });
  if (child.pid !== undefined) {
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
  }
  return child;
}

function recordAgentError(
  state: DriverState,
  record: SessionRecord,
  error: Error,
): void {
  if (record.status.phase !== "running") {
    return;
  }
  record.status = {
    phase: "failed",
    failure: { kind: "unknown", retryable: false, opaqueRef: error.message },
  };
  emit(state, "terminal");
}

/**
 * An exit the driver did not ask for is a failure of a started session, and
 * ends whatever is left of the agent's process group, as a container's
 * processes end with its first one.
 */
function recordAgentExit(
  state: DriverState,
  record: SessionRecord,
  exitCode: number | null,
): void {
  if (!record.stopping && record.child?.pid !== undefined) {
    signalGroup(record.child.pid, "SIGKILL");
  }
  record.status = record.stopping
    ? { phase: "stopped" }
    : {
        phase: "failed",
        failure: {
          kind: "started-then-died",
          retryable: false,
          ...(exitCode === null ? {} : { exitCode }),
        },
      };
  emit(state, "terminal");
}

async function sessionStatus(
  record: SessionRecord,
  ready: Promise<undefined>,
): Promise<SessionStatus> {
  await ready;
  return record.status;
}

/**
 * Stop the session: a running agent's process group receives `SIGTERM`, and
 * `SIGKILL` once the specification's grace period passes.
 */
async function stopSession(
  state: DriverState,
  record: SessionRecord,
  ready: Promise<undefined>,
): Promise<undefined> {
  await ready;
  const { status, child, spec } = record;
  if (status.phase === "stopped") {
    return;
  }
  if (status.phase === "running" && child?.pid !== undefined) {
    record.stopping = true;
    await terminate(child.pid, spec.stopGraceSeconds * 1_000);
  }
  markStopped(state, record);
}

function markStopped(state: DriverState, record: SessionRecord): void {
  record.status = { phase: "stopped" };
  emit(state, "terminal");
}

/**
 * `SIGTERM` the agent's process group, then `SIGKILL` whatever of it outlives
 * the grace period. It waits on the group rather than the agent, since a
 * descendant that ignores `SIGTERM` outlives an agent that honours it. A
 * member that has exited counts until its parent reaps it, and the images'
 * PID 1 reaps no orphans, so there a stop usually lasts both waits.
 */
async function terminate(
  processId: number,
  graceMillis: number,
): Promise<undefined> {
  signalGroup(processId, "SIGTERM");
  if (!(await groupEnds(processId, graceMillis))) {
    signalGroup(processId, "SIGKILL");
    await groupEnds(processId, KILL_WAIT_MILLIS);
  }
}

/** Whether the process group `processId` leads is gone within `timeoutMillis`. */
async function groupEnds(
  processId: number,
  timeoutMillis: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMillis;
  while (signalGroup(processId, 0)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(GROUP_POLL_MILLIS);
  }
  return true;
}

/** Signal the process group `processId` leads; `false` once it is gone. */
function signalGroup(processId: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-processId, signal);
    return true;
  } catch (error) {
    if (errorCode(error) !== "ESRCH") {
      throw error;
    }
    return false;
  }
}

/**
 * Link the session's mounts, then mark it ready. A refused mount fails the
 * session with `spec-invalid` and rejects `prepare`.
 */
async function materializeRecord(
  state: DriverState,
  record: SessionRecord,
  mounts: readonly MountSpec[],
): Promise<undefined> {
  const { resolveContainerPath, specInvalid } = state.settings;
  try {
    await materializeProcessMounts(mounts, {
      resolveContainerPath,
      specInvalid,
    });
  } catch (error) {
    record.status = {
      phase: "failed",
      failure: {
        kind: "spec-invalid",
        retryable: false,
        detail: error instanceof Error ? error.message : String(error),
      },
    };
    throw error;
  }
  record.status = { phase: "ready" };
  emit(state, "phase");
}

function emit(state: DriverState, kind: SessionEvent["kind"]): void {
  const { current } = state;
  if (current === undefined) {
    return;
  }
  const event = { key: current.record.spec.key, kind };
  for (const watcher of state.watchers.values()) {
    watcher(event);
  }
}

function sessionSnapshots(
  state: DriverState,
  installSlug: string,
): readonly SessionSnapshot[] {
  const { current } = state;
  return current?.record.spec.key.installSlug === installSlug
    ? [snapshot(current)]
    : [];
}

function snapshot({ record, handle }: Session): SessionSnapshot {
  const { status } = record;
  return {
    handle,
    phase: snapshotPhase(status),
    ...(status.phase === "failed" ? { failure: status.failure } : {}),
  };
}

function snapshotPhase(status: SessionStatus): SessionSnapshot["phase"] {
  switch (status.phase) {
    case "running":
      return "running";
    case "ready":
    case "preparing":
      return "starting";
    case "stopped":
    case "failed":
      return "terminal";
    default:
      return status satisfies never;
  }
}

function watchSessions(
  state: DriverState,
  installSlug: string,
  onEvent: (event: SessionEvent) => void,
): SessionWatch {
  const token = Symbol(installSlug);
  state.watchers.set(token, (event) => {
    if (event.key.installSlug === installSlug) {
      onEvent(event);
    }
  });
  return Object.freeze({
    stop: () => {
      state.watchers.delete(token);
    },
  });
}

function bindKey(state: DriverState, key: SessionKey): void {
  const { boundKey } = state;
  if (boundKey !== undefined && !sameKey(boundKey, key)) {
    throw state.settings.specInvalid(
      `one app container is already bound to ${keyText(boundKey)}; refused ${keyText(key)}`,
    );
  }
  state.boundKey ??= key;
}

function sameKey(left: SessionKey, right: SessionKey): boolean {
  return (
    left.installSlug === right.installSlug &&
    left.agentGroupId === right.agentGroupId &&
    left.sessionId === right.sessionId
  );
}

function keyText(key: SessionKey): string {
  return `${key.installSlug}/${key.agentGroupId}/${key.sessionId}`;
}

/**
 * Replace the mount target `path` with a link to `source`. A target that
 * already resolves to `source` stays; an empty directory or a link is
 * replaced; anything else is refused so no agent data is lost.
 */
async function replaceWithSymlink(
  path: string,
  source: string,
  specInvalid: SpecInvalid,
): Promise<undefined> {
  if (!isAbsolute(path) || !isAbsolute(source)) {
    throw specInvalid(
      `process-driver mounts must use absolute paths: ${source} -> ${path}`,
    );
  }
  const sourceInfo = await pathInfo(source);
  if (sourceInfo === undefined) {
    throw specInvalid(`process-driver mount source does not exist: ${source}`);
  }
  if (await resolvesTo(path, source)) {
    return;
  }
  await removeMountTarget(path, specInvalid);
  await mkdir(dirname(path), { recursive: true });
  await symlink(source, path, sourceInfo.isDirectory() ? "dir" : "file");
}

/** `true` when `path` already reaches `source`, even as a dangling link. */
async function resolvesTo(path: string, source: string): Promise<boolean> {
  const resolvedPath = await realpathIfResolvable(path);
  const resolvedSource =
    resolvedPath === undefined ? undefined : await realpathIfResolvable(source);
  if (resolvedPath !== undefined && resolvedSource !== undefined) {
    return resolvedPath === resolvedSource;
  }
  const info = await pathInfo(path);
  if (info?.isSymbolicLink() !== true) {
    return false;
  }
  return resolve(dirname(path), await readlink(path)) === resolve(source);
}

async function removeMountTarget(
  path: string,
  specInvalid: SpecInvalid,
): Promise<undefined> {
  const info = await pathInfo(path);
  if (info === undefined) {
    return;
  }
  if (info.isSymbolicLink()) {
    await unlink(path);
    return;
  }
  if (!info.isDirectory()) {
    throw specInvalid(`process-driver refuses to replace mount target ${path}`);
  }
  if ((await readdir(path)).length > 0) {
    throw specInvalid(
      `process-driver refuses to replace non-empty mount target ${path}`,
    );
  }
  await rmdir(path);
}

/** The real path of `path`, or `undefined` when the file system refuses it. */
async function realpathIfResolvable(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if (errorCode(error) !== undefined) {
      return undefined;
    }
    throw error;
  }
}

async function pathInfo(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}
