/**
 * @file SPIKE, not production code: negotiated norms in the daemon, as in
 * PLAN-one-sided-norms revision 8. Enabled by `SHARNESS_EXPERIMENT_NORMS`, a
 * JSON object `{"hold": ["<BEHAVIOR.md text>", …], "adopt": true, "waitSeconds": 30}`.
 *
 * - The holder's daemon negotiates before its agent's first send to agents it
 *   has no task with: `propose`, then waits for answers, then `start` with
 *   those that accepted. A message from a stranger is withheld and answered
 *   with a `propose`.
 * - A participant's daemon fetches a norm it lacks (`get-norm`, answered with
 *   `norm-text` in code), accepts by policy, and on `start` adopts the norms
 *   for the task's members. Its agent receives `start` with a notice naming
 *   the norm, which it reads with the `read_norms` tool, and, if its earlier
 *   message in the conversation was refused, why.
 * - A task is one conversation: the group or direct conversation it was
 *   proposed in. propose, start and withdraw go there; get-norm, norm-text,
 *   accept and reject go privately to the agent they answer, so the task's
 *   conversation never waits on them. Every message in it must be an act of a task norm. The
 *   sender's own firewall refuses a failing draft with what failed and the
 *   acts allowed now (repair); the receiver withholds a failing message.
 *
 * Negotiation acts never reach an agent except `start`. State lives in memory,
 * keyed by agent names; firewall inputs carry ids, translated through the
 * names the assessment learns from verified cards.
 */

import { createHash } from "node:crypto";
import { Deferred, Effect, Queue } from "effect";
import type {
  MessageMiddleware,
  MiddlewareInput,
  MiddlewareResult,
} from "../firewall/evaluator/contract/index.js";
import {
  makeProtocolForm,
  parseAct,
} from "../firewall/evaluator/protocol-form.js";
import type { HarnessNormsResult } from "../harness/mcp/tools.js";
import {
  allowedNext,
  makeProtocolState,
  type NextAct,
} from "../firewall/evaluator/protocol-state.js";

/** The protocol text's "message form" section: how any act is written. */
function formSection(protocol: string): string {
  const lines = protocol.split("\n");
  const start = lines.findIndex((line) => /^message form\s*$/u.test(line));
  if (start < 0) {
    return "";
  }
  const end = lines.findIndex(
    (line, index) => index > start && /^\S/u.test(line),
  );
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

/** The acts allowed next, written out, and how an act is written. */
function guidanceText(protocol: string, allowed: readonly NextAct[]): string {
  if (allowed.length === 0) {
    return "The norm allows you no message now; wait for the next one.";
  }
  return [
    "The norm allows you to send next exactly one of these acts, as the whole message:",
    ...allowed.map((act) => act.declaration),
    formSection(protocol),
  ].join("\n\n");
}

/** A held or fetched norm. */
interface Norm {
  readonly name: string;
  readonly description: string;
  readonly hash: string;
  readonly document: string;
  readonly protocol: string;
  readonly form: MessageMiddleware;
  readonly state: MessageMiddleware;
}

/** One negotiated task. */
interface Task {
  readonly task: string;
  readonly initiator: string;
  members: string[];
  readonly norms: string[];
  readonly role: "initiator" | "participant";
  status: "proposed" | "started" | "withdrawn";
  readonly answers: Map<string, "accept" | "reject">;
  readonly answered: Deferred.Deferred<void>;
  accepted: boolean;
  /** The conversation the task lives in: its participants' names, sorted. */
  readonly conversation: string;
  /** Where this daemon sends the task's acts: that conversation's address. */
  readonly address: string;
}

/** A send the daemon makes on its own account. */
type Job =
  | { readonly kind: "send"; readonly to: string; readonly text: string }
  | { readonly kind: "initiate"; readonly task: Task; readonly to: string };

/** The raw send that bypasses the spike's own wrapper. */
type RawSend = (input: {
  readonly to: string;
  readonly text: string;
}) => Effect.Effect<unknown, unknown>;

const NEGOTIATION = new Set([
  "propose",
  "get-norm",
  "norm-text",
  "accept",
  "reject",
  "start",
  "withdraw",
]);

interface Configuration {
  readonly hold: readonly string[];
  readonly adopt: boolean;
  readonly waitSeconds: number;
}

function configuration(): Configuration | undefined {
  const raw = process.env.SHARNESS_EXPERIMENT_NORMS;
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const parsed = JSON.parse(raw) as Partial<Configuration>;
  return {
    hold: parsed.hold ?? [],
    adopt: parsed.adopt ?? true,
    waitSeconds: parsed.waitSeconds ?? 30,
  };
}

const config = configuration();

/** Whether the spike is on for this process. */
export const normSpikeEnabled = config !== undefined;

const state = {
  names: new Map<string, string>(),
  self: undefined as string | undefined,
  norms: new Map<string, Norm>(),
  held: new Set<string>(),
  tasks: [] as Task[],
  seen: new Set<string>(),
  lastSent: new Map<string, string>(),
  own: new Map<string, number>(),
  outbox: Effect.runSync(Queue.unbounded<Job>()),
};

function normOf(document: string): Norm {
  const front = /^---\n([\s\S]*?)\n---\n/u.exec(document)?.[1] ?? "";
  const field = (key: string) =>
    new RegExp(`^${key}:\\s*(.+)$`, "mu").exec(front)?.[1]?.trim() ?? "";
  const protocol =
    /```[a-z]*\n([\s\S]*?)\n```/u.exec(document)?.[1]?.trim() ?? document;
  const name = field("name");
  const rule = {
    id: "norm",
    kind: "norm" as const,
    text: protocol,
    feedback: {
      text: `This message does not follow the ${name} norm.`,
      nextAction: "revise" as const,
    },
  };
  return {
    name,
    description: field("description"),
    hash: createHash("sha256").update(document).digest("hex").slice(0, 8),
    document,
    protocol,
    form: makeProtocolForm({ id: "form", rule }),
    state: makeProtocolState({ id: "state", rule }),
  };
}

for (const document of config?.hold ?? []) {
  const norm = normOf(document);
  state.norms.set(norm.name, norm);
  state.held.add(norm.name);
}

/** Teach the spike agent names from verified cards seen by an assessment. */
export function learnNames(
  cards: ReadonlyArray<{
    readonly agentId: string;
    readonly agentName: string;
  }>,
): void {
  for (const card of cards) {
    state.names.set(card.agentId, card.agentName);
  }
}

const nameOf = (id: string) => state.names.get(id) ?? id;

function act(name: string, params: Record<string, string>): string {
  return (
    [
      `(${name}`,
      ...Object.entries(params).map(([key, value]) => `  :${key} ${value}`),
    ].join("\n") + ")"
  );
}

const agents = (names: readonly string[]) =>
  `[${names.map((name) => `agent:${name}`).join(" | ")}]`;

const listNames = (value: string | undefined) =>
  (/^\[(.*)\]$/u.exec((value ?? "").trim())?.[1] ?? "")
    .split("|")
    .map((item) => item.trim().replace(/^agent:/u, ""))
    .filter((item) => item !== "");

/** A conversation's key: its participants' names, sorted and joined. */
const conversationOf = (participants: readonly string[]) =>
  [...new Set(participants)].sort().join(",");

/** The address this daemon sends to in a conversation with `participants`. */
function addressFor(participants: readonly string[], me: string): string {
  const unique = [...new Set(participants)].sort();
  return unique.length > 2
    ? `group:${unique.join(",")}`
    : `agent:${unique.find((name) => name !== me) ?? me}`;
}

function taskFor(
  participants: readonly string[],
  status: Task["status"],
): Task | undefined {
  return [...state.tasks]
    .reverse()
    .find(
      (task) =>
        task.status === status &&
        task.conversation === conversationOf(participants),
    );
}

function newTask(
  task: string,
  initiator: string,
  members: string[],
  norms: string[],
  role: Task["role"],
  me: string,
): Task {
  const created: Task = {
    task,
    initiator,
    members,
    norms,
    role,
    status: "proposed",
    answers: new Map(),
    answered: Effect.runSync(Deferred.make<void>()),
    accepted: false,
    conversation: conversationOf(members),
    address: addressFor(members, me),
  };
  state.tasks.push(created);
  return created;
}

const enqueue = (job: Job) => Queue.offer(state.outbox, job);

/**
 * The raw send, recording each text as the daemon's own so the outgoing
 * check passes it as a negotiation act. An agent's message that only looks
 * like one is checked under its task's norm like any other.
 * @param send The raw send.
 * @returns The recording send.
 */
function own(send: RawSend): RawSend {
  return (input) =>
    Effect.suspend(() => {
      state.own.set(input.text, (state.own.get(input.text) ?? 0) + 1);
      return send(input);
    });
}

/** Whether `text` is a send the daemon recorded as its own; consumes it. */
function ownSend(text: string): boolean {
  const count = state.own.get(text) ?? 0;
  if (count === 0) {
    return false;
  }
  if (count === 1) {
    state.own.delete(text);
  } else {
    state.own.set(text, count - 1);
  }
  return true;
}

const pass = (advice?: string): MiddlewareResult => ({
  findings: [{ ruleId: "norms", outcome: "pass" }],
  expectations: [],
  ...(advice === undefined
    ? {}
    : { trace: { format: "norm-advice/v1", data: advice } }),
});

const refuse = (
  direction: "incoming" | "outgoing",
  advice?: string,
): MiddlewareResult => ({
  findings: [
    { ruleId: "norms", outcome: direction === "incoming" ? "block" : "revise" },
  ],
  expectations: [],
  ...(advice === undefined
    ? {}
    : { trace: { format: "norm-advice/v1", data: advice } }),
});

/** The input with agent ids replaced by names, as the norm texts name agents. */
function named(input: MiddlewareInput): MiddlewareInput {
  const message = input.event.message;
  return {
    ...input,
    event: {
      ...input.event,
      message: {
        ...message,
        sender: nameOf(message.sender),
        recipients: message.recipients.map(nameOf) as [string, ...string[]],
      },
    },
    context: {
      ...input.context,
      agentId: nameOf(input.context.agentId),
      history: input.context.history.map((entry) => ({
        ...entry,
        sender: nameOf(entry.sender),
        recipients: entry.recipients.map(nameOf) as [string, ...string[]],
      })),
    },
  } as MiddlewareInput;
}

function errorsOf(result: MiddlewareResult): string[] {
  const data = result.trace?.data;
  if (data === undefined) {
    return [];
  }
  return (JSON.parse(data) as { errors?: string[] }).errors ?? [];
}

/** The norm a message falls under: the one declaring its act, else the first. */
function normFor(task: Task, text: string): Norm | undefined {
  const parsed = parseAct(text);
  const norms = task.norms
    .map((name) => state.norms.get(name))
    .filter((norm) => norm !== undefined);
  if (typeof parsed !== "string") {
    const declaring = norms.find((norm) =>
      new RegExp(`^\\s+\\(${parsed.name}\\s*$`, "mu").test(norm.protocol),
    );
    if (declaring !== undefined) {
      return declaring;
    }
  }
  return norms[0];
}

function historyPosts(input: MiddlewareInput) {
  return input.context.history
    .filter((entry) => entry.admission === "admitted")
    .map((entry) => ({
      sender: entry.sender,
      recipients: entry.recipients,
      text: entry.text,
    }));
}

function repair(norm: Norm, input: MiddlewareInput, errors: readonly string[]) {
  const me = input.event.message.sender;
  return [
    `Your message was not sent: it does not follow the ${norm.name} norm agreed for this task. What the checks found: ${errors.join("; ")}.`,
    guidanceText(
      norm.protocol,
      allowedNext(norm.protocol, historyPosts(input), me),
    ),
  ].join("\n\n");
}

/** Form and state checks of one message under the task's norms. */
const checkUnder = Effect.fn("normSpike.checkUnder")(function* (
  task: Task,
  input: MiddlewareInput,
) {
  const norm = normFor(task, input.event.message.text);
  if (norm === undefined) {
    return { norm, errors: [] as string[] };
  }
  const form = yield* norm.form.check(input);
  const checked = yield* norm.state.check(input);
  return { norm, errors: [...errorsOf(form), ...errorsOf(checked)] };
});

function notice(task: Task, me: string): string {
  const norms = task.norms
    .map((name) => state.norms.get(name))
    .filter((norm) => norm !== undefined);
  const lines = [
    `Your messaging daemon accepted, for you, the task "${task.task}" proposed by agent:${task.initiator}. Every message among ${agents(task.members)} in this task must follow the norm ${norms.map((n) => n.name).join(", ")}. Read it with the read_norms tool before you reply.`,
  ];
  const earlier = state.lastSent.get(task.conversation);
  const first = norms[0];
  if (earlier !== undefined && first !== undefined) {
    const parsed = parseAct(earlier);
    if (
      typeof parsed === "string" ||
      !first.protocol.includes(`(${parsed.name}`)
    ) {
      lines.push(
        `Your earlier message in this conversation was not delivered: it is not a message the norm allows (${typeof parsed === "string" ? parsed : `unknown act ${parsed.name}`}). Send it again in the norm's form.\n\n${guidanceText(first.protocol, allowedNext(first.protocol, [], me))}`,
      );
    }
  }
  return lines.join("\n\n");
}

/**
 * The norms in force, for the `read_norms` tool: the started tasks and every
 * norm held or adopted, with its whole text.
 * @returns The tasks and norms.
 */
export function readNorms(): Effect.Effect<HarnessNormsResult> {
  return Effect.sync(() => ({
    tasks: state.tasks
      .filter((task) => task.status === "started")
      .map((task) => ({
        conversation: task.address,
        task: task.task,
        initiator: `agent:${task.initiator}`,
        members: task.members.map((name) => `agent:${name}`),
        norms: task.norms,
      })),
    norms: [...state.norms.values()].map((norm) => ({
      name: norm.name,
      description: norm.description,
      text: norm.document,
    })),
  }));
}

/** Decide on a proposal once every norm it names is known. */
function answerIfReady(task: Task) {
  return Effect.gen(function* () {
    if (task.role !== "participant" || task.accepted) {
      return;
    }
    if (!task.norms.every((name) => state.norms.has(name))) {
      return;
    }
    task.accepted = true;
    yield* enqueue({
      kind: "send",
      to: `agent:${task.initiator}`,
      text:
        config?.adopt === false
          ? act("reject", { task: task.task, reason: "declined-by-agent" })
          : act("accept", { task: task.task }),
    });
  });
}

/** An incoming negotiation act, handled in code; returns advice for `start`. */
const negotiate = Effect.fn("normSpike.negotiate")(function* (
  input: MiddlewareInput,
  name: string,
  values: ReadonlyMap<string, string>,
) {
  const me = input.context.agentId;
  const sender = input.event.message.sender;
  const here = [sender, ...input.event.message.recipients];
  const taskId = values.get("task") ?? "";
  const task = state.tasks.find((t) => t.task === taskId);
  switch (name) {
    case "propose": {
      const members = listNames(values.get("members"));
      if (!members.includes(me) || task !== undefined) {
        return undefined;
      }
      const created = newTask(
        taskId,
        sender,
        here,
        listNames(values.get("norms")),
        "participant",
        me,
      );
      for (const norm of created.norms.filter((n) => !state.norms.has(n))) {
        yield* enqueue({
          kind: "send",
          to: `agent:${sender}`,
          text: act("get-norm", { task: taskId, name: norm }),
        });
      }
      yield* answerIfReady(created);
      return undefined;
    }
    case "get-norm": {
      const norm = state.norms.get(values.get("name") ?? "");
      if (norm !== undefined) {
        yield* enqueue({
          kind: "send",
          to: `agent:${sender}`,
          text: act("norm-text", {
            task: taskId,
            name: norm.name,
            hash: norm.hash,
            text: JSON.stringify(norm.document),
          }),
        });
      }
      return undefined;
    }
    case "norm-text": {
      const text = values.get("text");
      if (text !== undefined) {
        const norm = normOf(JSON.parse(text) as string);
        state.norms.set(norm.name, norm);
      }
      if (task !== undefined) {
        yield* answerIfReady(task);
      }
      return undefined;
    }
    case "accept":
    case "reject": {
      if (task?.role === "initiator") {
        task.answers.set(sender, name);
        const participants = task.members.filter((m) => m !== me);
        if (participants.every((m) => task.answers.has(m))) {
          yield* Deferred.succeed(task.answered, undefined);
        }
      }
      return undefined;
    }
    case "start": {
      if (task?.role !== "participant") {
        return undefined;
      }
      task.status = "started";
      task.members = [task.initiator, ...listNames(values.get("members"))];
      return notice(task, me);
    }
    case "withdraw": {
      if (task !== undefined) {
        task.status = "withdrawn";
      }
      return undefined;
    }
    default:
      return undefined;
  }
});

/** The firewall check the spike installs in both directions. */
export const normsMiddleware: MessageMiddleware = {
  id: "norms",
  revision: "norm-spike-v1",
  rules: [
    {
      id: "norms",
      kind: "norm",
      feedback: {
        text: "This message does not follow the norms agreed for this task.",
        nextAction: "revise",
      },
    },
  ],
  check: (raw) =>
    Effect.gen(function* () {
      const input = named(raw);
      const direction = input.event.direction;
      const message = input.event.message;
      const me = input.context.agentId;
      state.self = me;
      const parsed = parseAct(message.text);
      if (direction === "outgoing" && ownSend(message.text)) {
        return pass();
      }
      if (
        direction === "incoming" &&
        typeof parsed !== "string" &&
        NEGOTIATION.has(parsed.name)
      ) {
        const first = !state.seen.has(message.id);
        state.seen.add(message.id);
        const advice = first
          ? yield* negotiate(input, parsed.name, new Map(parsed.values))
          : undefined;
        return parsed.name === "start" ? pass(advice) : refuse("incoming");
      }
      const participants = [
        ...new Set([message.sender, ...message.recipients]),
      ];
      const task = taskFor(participants, "started");
      if (task === undefined) {
        if (direction === "incoming" && state.held.size > 0) {
          if (
            !state.seen.has(message.id) &&
            taskFor(participants, "proposed") === undefined
          ) {
            const stranger = newTask(
              [...state.held]
                .map((name) => state.norms.get(name)?.description ?? name)
                .join("; "),
              me,
              participants,
              [...state.held],
              "initiator",
              me,
            );
            yield* enqueue({
              kind: "initiate",
              task: stranger,
              to: stranger.address,
            });
          }
          state.seen.add(message.id);
          return refuse("incoming");
        }
        return pass();
      }
      const { norm, errors } = yield* checkUnder(task, input);
      if (norm === undefined || errors.length === 0) {
        return pass();
      }
      return direction === "outgoing"
        ? refuse("outgoing", repair(norm, input, errors))
        : refuse("incoming");
    }).pipe(Effect.orDie),
};

/** Propose, wait for answers, then start or withdraw; returns whether the task started. */
const initiate = Effect.fn("normSpike.initiate")(function* (
  task: Task,
  to: string,
  send: RawSend,
) {
  const participants = task.members.filter((m) => m !== task.initiator);
  yield* send({
    to,
    text: act("propose", {
      task: task.task,
      members: agents(participants),
      norms: `[${task.norms.join(" | ")}]`,
    }),
  }).pipe(Effect.ignore);
  yield* Deferred.await(task.answered).pipe(
    Effect.timeout(`${config?.waitSeconds ?? 30} seconds`),
    Effect.ignore,
  );
  const accepted = participants.filter((m) => task.answers.get(m) === "accept");
  if (accepted.length === 0) {
    task.status = "withdrawn";
    yield* send({
      to,
      text: act("withdraw", { task: task.task, reason: "no-acceptance" }),
    }).pipe(Effect.ignore);
    return false;
  }
  task.members = [task.initiator, ...accepted];
  yield* send({
    to,
    text: act("start", { task: task.task, members: agents(accepted) }),
  }).pipe(Effect.ignore);
  task.status = "started";
  return true;
});

/** Names in a send's address other than the sender's own. */
function addressees(to: string, me: string): string[] {
  if (to.startsWith("agent:")) {
    return [to.slice("agent:".length)];
  }
  return to
    .replace(/^group:/u, "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "" && name !== me);
}

/**
 * Before an agent's send: remember it, and when this agent holds norms and
 * has no task with these addressees, negotiate one first.
 */
export const beforeSend = Effect.fn("normSpike.beforeSend")(function* (
  input: { readonly to: string; readonly text?: string },
  me: string,
  send: RawSend,
) {
  state.self = me;
  const text = input.text;
  if (text === undefined) {
    return true;
  }
  const others = addressees(input.to, me);
  state.lastSent.set(conversationOf([me, ...others]), text);
  if (state.held.size === 0) {
    return true;
  }
  const participants = [me, ...others];
  if (taskFor(participants, "started") !== undefined) {
    return true;
  }
  const pending = taskFor(participants, "proposed");
  if (pending !== undefined) {
    yield* Deferred.await(pending.answered).pipe(
      Effect.timeout(`${config?.waitSeconds ?? 30} seconds`),
      Effect.ignore,
    );
    return taskFor(participants, "started") !== undefined;
  }
  const norm = [...state.held][0] ?? "norm";
  const task = newTask(
    `${norm} with ${agents(others)} at ${new Date().toISOString().slice(11, 19)}`,
    me,
    participants,
    [...state.held],
    "initiator",
    me,
  );
  return yield* initiate(task, input.to, own(send));
});

/** Drains the daemon's own sends: replies, and stranger negotiations, forked. */
export const runOutbox = Effect.fn("normSpike.runOutbox")(function* (
  sender: () => RawSend | undefined,
) {
  for (;;) {
    const job = yield* Queue.take(state.outbox);
    let raw = sender();
    while (raw === undefined) {
      yield* Effect.sleep("1 second");
      raw = sender();
    }
    const send = own(raw);
    if (job.kind === "send") {
      yield* send({ to: job.to, text: job.text }).pipe(
        Effect.tapError((error) =>
          Effect.logWarning(`norm spike send failed: ${String(error)}`),
        ),
        Effect.ignore,
      );
    } else {
      yield* initiate(job.task, job.to, send).pipe(Effect.forkDaemon);
    }
  }
});

/** The text of the spike's advice in one check result's traces, if any. */
export function adviceOf(
  checks: ReadonlyArray<{
    readonly trace?: { readonly format: string; readonly data: string };
  }>,
): string | undefined {
  return checks.find((check) => check.trace?.format === "norm-advice/v1")?.trace
    ?.data;
}
