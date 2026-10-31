/**
 * @file Experiment: checks the conversation state of structured protocol
 * messages in code. Under each act the protocol text declares "when" lines
 * (alternative conditions for sending it) and "check" lines (mechanical checks
 * on its values), in the fixed vocabulary its "state" section defines. This
 * check replays the conversation's acts against those declarations and
 * refuses a message they do not allow. It knows only what the messages say,
 * never the calendar; what free-text values carry is left to the decision
 * provider.
 */

import { Effect } from "effect";
import type {
  MessageMiddleware,
  MiddlewareInput,
  MiddlewareResult,
  RuleDescription,
} from "./contract/index.js";
import { declaredActs, parseAct } from "./protocol-form.js";

type Condition =
  | {
      readonly kind:
        | "opens"
        | "resend"
        | "answers"
        | "final"
        | "unprompted"
        | "names-escalated"
        | "sent-by-member"
        | "once-per-sender";
    }
  | { readonly kind: "every-member-sent"; readonly act: string }
  | {
      readonly kind: "every-member-sent-since" | "sent-since-latest";
      readonly act: string;
      readonly since: string;
    }
  | { readonly kind: "once-per-sender-since"; readonly since: string }
  | {
      readonly kind: "all-since" | "some-since";
      readonly act: string;
      readonly since: string;
      readonly q: string;
      readonly value: string;
    }
  | { readonly kind: "once-per-recipient" }
  | {
      readonly kind: "recipients-answered";
      readonly act: string;
      readonly by: string;
    }
  | { readonly kind: "after" | "opened-by"; readonly acts: readonly string[] }
  | {
      readonly kind: "count-is" | "count-below";
      readonly act: string;
      readonly n: number;
    };

type Check =
  | {
      readonly kind: "number-in";
      readonly p: string;
      readonly act: string;
      readonly q: string;
    }
  | { readonly kind: "matches-accepted"; readonly p: string }
  | {
      readonly kind: "item-count";
      readonly p: string;
      readonly min: number;
      readonly max: number;
    }
  | { readonly kind: "ends-with"; readonly p: string; readonly suffix: string }
  | {
      readonly kind: "items-in-latest" | "number-in-every";
      readonly p: string;
      readonly act: string;
      readonly q: string;
    }
  | { readonly kind: "none-in-every"; readonly act: string; readonly q: string }
  | {
      readonly kind: "equals-latest";
      readonly p: string;
      readonly q: string;
      readonly act: string;
    }
  | {
      readonly kind: "matches-item";
      readonly p: string;
      readonly q: string;
      readonly act: string;
      readonly r: string;
    }
  | { readonly kind: "is-number"; readonly p: string; readonly n: number }
  | {
      readonly kind: "one-more" | "none-or-number-in";
      readonly p: string;
      readonly q: string;
      readonly act: string;
    }
  | { readonly kind: "greater"; readonly p: string; readonly q: string }
  | {
      readonly kind: "largest-since";
      readonly p: string;
      readonly q: string;
      readonly act: string;
      readonly since: string;
    }
  | {
      readonly kind: "within-every";
      readonly p: string;
      readonly act: string;
      readonly q: string;
    }
  | {
      readonly kind: "no-range-in-every";
      readonly act: string;
      readonly q: string;
    }
  | {
      readonly kind: "present-when";
      readonly p: string;
      readonly q: string;
      readonly value: string;
    };

interface Declaration {
  readonly when: Condition[][];
  readonly checks: Array<{ readonly after?: string; readonly check: Check }>;
}

const names = (text: string) =>
  text
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");

function parseCondition(text: string): Condition | undefined {
  const part = text.trim();
  switch (part) {
    case "opens":
    case "resend":
    case "answers":
    case "final":
    case "unprompted":
      return { kind: part };
    case "names an escalated request":
      return { kind: "names-escalated" };
    case "sent by a member":
      return { kind: "sent-by-member" };
    case "once per sender":
      return { kind: "once-per-sender" };
    default:
      break;
  }
  if (part === "once per recipient") {
    return { kind: "once-per-recipient" };
  }
  const everySince =
    /^every member has sent ([a-z-]+) since the latest ([a-z-]+)$/u.exec(part);
  if (everySince !== null) {
    return {
      kind: "every-member-sent-since",
      act: everySince[1] ?? "",
      since: everySince[2] ?? "",
    };
  }
  const onceSince = /^once per sender since the latest ([a-z-]+)$/u.exec(part);
  if (onceSince !== null) {
    return { kind: "once-per-sender-since", since: onceSince[1] ?? "" };
  }
  const quantified =
    /^(every|some) ([a-z-]+) since the latest ([a-z-]+) has :([a-z-]+) (\S+)$/u.exec(
      part,
    );
  if (quantified !== null) {
    return {
      kind: quantified[1] === "every" ? "all-since" : "some-since",
      act: quantified[2] ?? "",
      since: quantified[3] ?? "",
      q: quantified[4] ?? "",
      value: quantified[5] ?? "",
    };
  }
  const sentSince =
    /^the sender was sent ([a-z-]+) after its latest ([a-z-]+)$/u.exec(part);
  if (sentSince !== null) {
    return {
      kind: "sent-since-latest",
      since: sentSince[1] ?? "",
      act: sentSince[2] ?? "",
    };
  }
  const answered =
    /^every agent sent ([a-z-]+) has sent ([a-z-]+) after it$/u.exec(part);
  if (answered !== null) {
    return {
      kind: "recipients-answered",
      act: answered[1] ?? "",
      by: answered[2] ?? "",
    };
  }
  const everyMember = /^every member has sent ([a-z-]+)$/u.exec(part);
  if (everyMember !== null) {
    return { kind: "every-member-sent", act: everyMember[1] ?? "" };
  }
  const after = /^after (.+)$/u.exec(part);
  if (after !== null) {
    return { kind: "after", acts: names(after[1] ?? "") };
  }
  const openedBy = /^opened by (.+)$/u.exec(part);
  if (openedBy !== null) {
    return { kind: "opened-by", acts: names(openedBy[1] ?? "") };
  }
  const countIs = /^(\d+) ([a-z-]+) so far$/u.exec(part);
  if (countIs !== null) {
    return { kind: "count-is", act: countIs[2] ?? "", n: Number(countIs[1]) };
  }
  const below = /^fewer than (\d+) ([a-z-]+)$/u.exec(part);
  if (below !== null) {
    return { kind: "count-below", act: below[2] ?? "", n: Number(below[1]) };
  }
  return undefined;
}

function parseCheck(text: string): Check | undefined {
  const part = text.trim();
  const isNumber = /^:([a-z-]+) is (\d+)$/u.exec(part);
  if (isNumber !== null) {
    return { kind: "is-number", p: isNumber[1] ?? "", n: Number(isNumber[2]) };
  }
  const oneMore =
    /^:([a-z-]+) is one more than :([a-z-]+) of the latest ([a-z-]+)$/u.exec(
      part,
    );
  if (oneMore !== null) {
    return {
      kind: "one-more",
      p: oneMore[1] ?? "",
      q: oneMore[2] ?? "",
      act: oneMore[3] ?? "",
    };
  }
  const noneOr =
    /^:([a-z-]+) is none or a number in the latest ([a-z-]+) :([a-z-]+)$/u.exec(
      part,
    );
  if (noneOr !== null) {
    return {
      kind: "none-or-number-in",
      p: noneOr[1] ?? "",
      act: noneOr[2] ?? "",
      q: noneOr[3] ?? "",
    };
  }
  const greater = /^:([a-z-]+) is greater than :([a-z-]+)$/u.exec(part);
  if (greater !== null) {
    return { kind: "greater", p: greater[1] ?? "", q: greater[2] ?? "" };
  }
  const largest =
    /^:([a-z-]+) is the largest :([a-z-]+) of the ([a-z-]+) since the latest ([a-z-]+)$/u.exec(
      part,
    );
  if (largest !== null) {
    return {
      kind: "largest-since",
      p: largest[1] ?? "",
      q: largest[2] ?? "",
      act: largest[3] ?? "",
      since: largest[4] ?? "",
    };
  }
  const within =
    /^:([a-z-]+) lies within an item of every ([a-z-]+) :([a-z-]+)$/u.exec(
      part,
    );
  if (within !== null) {
    return {
      kind: "within-every",
      p: within[1] ?? "",
      act: within[2] ?? "",
      q: within[3] ?? "",
    };
  }
  const noRange =
    /^no slot lies within an item of every ([a-z-]+) :([a-z-]+)$/u.exec(part);
  if (noRange !== null) {
    return {
      kind: "no-range-in-every",
      act: noRange[1] ?? "",
      q: noRange[2] ?? "",
    };
  }
  const numberIn =
    /^:([a-z-]+) is a number in the latest ([a-z-]+) :([a-z-]+)$/u.exec(part);
  if (numberIn !== null) {
    return {
      kind: "number-in",
      p: numberIn[1] ?? "",
      act: numberIn[2] ?? "",
      q: numberIn[3] ?? "",
    };
  }
  const itemsIn =
    /^:([a-z-]+) items are numbers in the latest ([a-z-]+) :([a-z-]+)$/u.exec(
      part,
    );
  if (itemsIn !== null) {
    return {
      kind: "items-in-latest",
      p: itemsIn[1] ?? "",
      act: itemsIn[2] ?? "",
      q: itemsIn[3] ?? "",
    };
  }
  const inEvery =
    /^:([a-z-]+) is a number in every ([a-z-]+) :([a-z-]+)$/u.exec(part);
  if (inEvery !== null) {
    return {
      kind: "number-in-every",
      p: inEvery[1] ?? "",
      act: inEvery[2] ?? "",
      q: inEvery[3] ?? "",
    };
  }
  const noneInEvery = /^no number is in every ([a-z-]+) :([a-z-]+)$/u.exec(
    part,
  );
  if (noneInEvery !== null) {
    return {
      kind: "none-in-every",
      act: noneInEvery[1] ?? "",
      q: noneInEvery[2] ?? "",
    };
  }
  const item =
    /^:([a-z-]+) matches item :([a-z-]+) of the latest ([a-z-]+) :([a-z-]+)$/u.exec(
      part,
    );
  if (item !== null) {
    return {
      kind: "matches-item",
      p: item[1] ?? "",
      q: item[2] ?? "",
      act: item[3] ?? "",
      r: item[4] ?? "",
    };
  }
  const equals = /^:([a-z-]+) equals :([a-z-]+) of the latest ([a-z-]+)$/u.exec(
    part,
  );
  if (equals !== null) {
    return {
      kind: "equals-latest",
      p: equals[1] ?? "",
      q: equals[2] ?? "",
      act: equals[3] ?? "",
    };
  }
  const accepted = /^:([a-z-]+) matches the accepted option$/u.exec(part);
  if (accepted !== null) {
    return { kind: "matches-accepted", p: accepted[1] ?? "" };
  }
  const count = /^:([a-z-]+) has (\d+) to (\d+) items$/u.exec(part);
  if (count !== null) {
    return {
      kind: "item-count",
      p: count[1] ?? "",
      min: Number(count[2]),
      max: Number(count[3]),
    };
  }
  const ending = /^:([a-z-]+) ends with (\S+)$/u.exec(part);
  if (ending !== null) {
    return { kind: "ends-with", p: ending[1] ?? "", suffix: ending[2] ?? "" };
  }
  const present =
    /^:([a-z-]+) is present exactly when :([a-z-]+) is (\S+)$/u.exec(part);
  if (present !== null) {
    return {
      kind: "present-when",
      p: present[1] ?? "",
      q: present[2] ?? "",
      value: present[3] ?? "",
    };
  }
  return undefined;
}

/** The "when" and "check" lines a protocol text declares under each act. */
export function declaredStates(
  protocol: string,
): ReadonlyMap<string, Declaration> {
  const declarations = new Map<string, Declaration>();
  let current: Declaration | undefined;
  let inActs = false;
  for (const line of protocol.split("\n")) {
    if (/^\S/u.test(line)) {
      inActs = line.startsWith("acts sent by");
      current = undefined;
      continue;
    }
    if (!inActs) {
      continue;
    }
    const start = /^\s+\(([a-z][a-z-]*)\s*$/u.exec(line);
    if (start !== null) {
      current = { when: [], checks: [] };
      declarations.set(start[1] ?? "", current);
      continue;
    }
    if (current === undefined) {
      continue;
    }
    const when = /^\s+when (.+)$/u.exec(line);
    if (when !== null) {
      current.when.push(
        (when[1] ?? "")
          .split(";")
          .map(parseCondition)
          .filter((condition) => condition !== undefined),
      );
      continue;
    }
    const check = /^\s+check (?:after ([a-z-]+): )?(.+)$/u.exec(line);
    if (check !== null) {
      const parsed = parseCheck(check[2] ?? "");
      if (parsed !== undefined) {
        current.checks.push({ after: check[1], check: parsed });
      }
    }
  }
  return declarations;
}

/**
 * The parameters of each act whose values code fixes completely: the request
 * id, "one of" values, and option numbers a check resolves. The decision
 * provider is not asked about them.
 * @param protocol The protocol text.
 * @returns For each act, the names of those parameters.
 */
export function codeFixedParameters(
  protocol: string,
): ReadonlyMap<string, ReadonlySet<string>> {
  const idParameter = /id in :([a-z-]+)/u.exec(protocol)?.[1] ?? "request";
  const states = declaredStates(protocol);
  const fixed = new Map<string, ReadonlySet<string>>();
  for (const [name, act] of declaredActs(protocol)) {
    const numbered = (states.get(name)?.checks ?? []).flatMap(({ check }) =>
      check.kind === "number-in" ||
      check.kind === "is-number" ||
      check.kind === "one-more" ||
      check.kind === "none-or-number-in" ||
      check.kind === "largest-since" ||
      check.kind === "within-every"
        ? [check.p]
        : [],
    );
    const enumerated = [...act.parameters]
      .filter(([, parameter]) => parameter.allowed !== undefined)
      .map(([parameter]) => parameter);
    fixed.set(name, new Set([idParameter, ...numbered, ...enumerated]));
  }
  return fixed;
}

interface SentAct {
  readonly name: string;
  readonly values: ReadonlyMap<string, string>;
  readonly sender: string;
  readonly recipients: readonly string[];
}

interface Request {
  readonly id: string;
  readonly acts: SentAct[];
  closedBy?: string;
  resent: boolean;
}

interface State {
  readonly requests: Map<string, Request>;
  open?: Request;
}

const listItems = (value: string | undefined): string[] => {
  const match = /^\[(.*)\]$/u.exec((value ?? "").trim());
  return match === null
    ? []
    : (match[1] ?? "")
        .split("|")
        .map((item) => item.trim())
        .filter((item) => item !== "");
};

const slotKey = (slot: string) =>
  slot
    .replace(/^\s*\d+[.)]?\s+/u, "")
    .replace(/[–—-]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();

/** An agent named by address or id, without its "agent:" prefix. */
const agentKey = (name: string) => name.trim().replace(/^agent:/u, "");

/** The members the act that opened `request` lists in its :members. */
const membersOf = (request: Request) =>
  new Set(listItems(request.acts[0]?.values.get("members")).map(agentKey));

const numbersOf = (value: string | undefined) =>
  (value ?? "").trim() === "none"
    ? []
    : listItems(value).map((item) => /^\s*(\d+)/u.exec(item)?.[1] ?? item);

const canonical = (act: SentAct) =>
  JSON.stringify([act.sender, act.name, [...act.values].sort()]);

/** The index of the last act `matches`, or -1. */
function lastIndexWhere(
  acts: readonly SentAct[],
  matches: (act: SentAct) => boolean,
): number {
  for (let index = acts.length - 1; index >= 0; index--) {
    const act = acts[index];
    if (act !== undefined && matches(act)) {
      return index;
    }
  }
  return -1;
}

/** The open meeting's acts after its latest `name`, or undefined when it has none. */
function actsSince(request: Request, name: string): SentAct[] | undefined {
  const index = lastIndexWhere(request.acts, (act) => act.name === name);
  return index < 0 ? undefined : request.acts.slice(index + 1);
}

/** Each sender's latest act named `name` in `request`; a later one replaces an earlier one. */
function latestPerSender(
  request: Request | undefined,
  name: string,
): SentAct[] {
  const latest = new Map<string, SentAct>();
  for (const act of request?.acts ?? []) {
    if (act.name === name) {
      latest.set(agentKey(act.sender), act);
    }
  }
  return [...latest.values()];
}

interface Range {
  readonly day: string;
  readonly start: number;
  readonly end: number;
}

const WEEKDAYS = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

/** "<day> <start>–<end>" as minutes within that day, or undefined. */
function rangeOf(text: string): Range | undefined {
  const match =
    /([a-z]{3})[a-z]*\.?\s+(\d{1,2}):(\d{2})\s*[–—-]\s*(\d{1,2}):(\d{2})/iu.exec(
      text,
    );
  const day = (match?.[1] ?? "").toLowerCase();
  if (match === null || !WEEKDAYS.has(day)) {
    return undefined;
  }
  return {
    day,
    start: Number(match[2]) * 60 + Number(match[3]),
    end: Number(match[4]) * 60 + Number(match[5]),
  };
}

const rangesOf = (value: string | undefined): Range[] =>
  listItems(value)
    .map(rangeOf)
    .filter((range) => range !== undefined);

/** The meeting length the opening act states, in minutes; 30 when it states none. */
const lengthOf = (request: Request | undefined) =>
  Number(
    /(\d+)/u.exec(request?.acts[0]?.values.get("length") ?? "")?.[1] ?? 30,
  );

/** Whether some `length`-minute slot falls inside a range of every list. */
function commonSlotExists(
  lists: ReadonlyArray<readonly Range[]>,
  length: number,
): boolean {
  const fits = (ranges: readonly Range[], day: string, start: number) =>
    ranges.some(
      (range) =>
        range.day === day &&
        range.start <= start &&
        start + length <= range.end,
    );
  return (lists[0] ?? []).some((range) =>
    Array.from(
      { length: Math.max(0, range.end - range.start - length + 1) },
      (_, offset) => range.start + offset,
    ).some((start) => lists.every((ranges) => fits(ranges, range.day, start))),
  );
}

function holds(
  condition: Condition,
  act: SentAct,
  state: State,
  idParameter: string,
): boolean {
  const open = state.open;
  const last = open?.acts.at(-1);
  switch (condition.kind) {
    case "opens":
      return (
        open === undefined &&
        !state.requests.has(act.values.get(idParameter) ?? "")
      );
    case "resend":
      return (
        open !== undefined &&
        !open.resent &&
        open.acts.length === 1 &&
        open.acts[0] !== undefined &&
        canonical(open.acts[0]) === canonical(act)
      );
    case "answers":
      return open !== undefined && act.values.get(idParameter) === open.id;
    case "final":
    case "unprompted":
      return true;
    case "names-escalated": {
      const named = state.requests.get(act.values.get(idParameter) ?? "");
      return (
        named !== undefined &&
        named.closedBy === "inform-escalated" &&
        !named.acts.some((earlier) => earlier.name === act.name)
      );
    }
    case "sent-by-member":
      return open !== undefined && membersOf(open).has(agentKey(act.sender));
    case "once-per-sender":
      return (
        open !== undefined &&
        !open.acts.some(
          (earlier) =>
            earlier.name === act.name && earlier.sender === act.sender,
        )
      );
    case "every-member-sent": {
      if (open === undefined) {
        return false;
      }
      const senders = new Set(
        open.acts
          .filter((earlier) => earlier.name === condition.act)
          .map((earlier) => agentKey(earlier.sender)),
      );
      const members = membersOf(open);
      return members.size > 0 && [...members].every((m) => senders.has(m));
    }
    case "every-member-sent-since": {
      const since =
        open === undefined ? undefined : actsSince(open, condition.since);
      if (open === undefined || since === undefined) {
        return false;
      }
      const senders = new Set(
        since
          .filter((earlier) => earlier.name === condition.act)
          .map((earlier) => agentKey(earlier.sender)),
      );
      const members = membersOf(open);
      return members.size > 0 && [...members].every((m) => senders.has(m));
    }
    case "once-per-sender-since": {
      const since =
        open === undefined ? undefined : actsSince(open, condition.since);
      return (
        since !== undefined &&
        !since.some(
          (earlier) =>
            earlier.name === act.name &&
            agentKey(earlier.sender) === agentKey(act.sender),
        )
      );
    }
    case "all-since":
    case "some-since": {
      const answers = (
        open === undefined ? undefined : actsSince(open, condition.since)
      )?.filter((earlier) => earlier.name === condition.act);
      const matches = (earlier: SentAct) =>
        (earlier.values.get(condition.q) ?? "").trim() === condition.value;
      return (
        answers !== undefined &&
        answers.length > 0 &&
        (condition.kind === "all-since"
          ? answers.every(matches)
          : answers.some(matches))
      );
    }
    case "sent-since-latest": {
      if (open === undefined) {
        return false;
      }
      const sender = agentKey(act.sender);
      const own = lastIndexWhere(
        open.acts,
        (earlier) =>
          earlier.name === condition.act && agentKey(earlier.sender) === sender,
      );
      return open.acts
        .slice(own + 1)
        .some(
          (earlier) =>
            earlier.name === condition.since &&
            earlier.recipients.map(agentKey).includes(sender),
        );
    }
    case "once-per-recipient": {
      const earlier = new Set(
        (open?.acts ?? [])
          .filter((sent) => sent.name === act.name)
          .flatMap((sent) => sent.recipients.map(agentKey)),
      );
      return (
        open !== undefined &&
        act.recipients.every((recipient) => !earlier.has(agentKey(recipient)))
      );
    }
    case "recipients-answered":
      return (
        open !== undefined &&
        open.acts.every(
          (sent, index) =>
            sent.name !== condition.act ||
            sent.recipients
              .map(agentKey)
              .every((recipient) =>
                open.acts
                  .slice(index + 1)
                  .some(
                    (reply) =>
                      reply.name === condition.by &&
                      agentKey(reply.sender) === recipient,
                  ),
              ),
        )
      );
    case "after":
      return last !== undefined && condition.acts.includes(last.name);
    case "opened-by":
      return (
        open?.acts[0] !== undefined &&
        condition.acts.includes(open.acts[0].name)
      );
    case "count-is":
    case "count-below": {
      const count =
        open?.acts.filter((earlier) => earlier.name === condition.act).length ??
        0;
      return (
        open !== undefined &&
        (condition.kind === "count-is"
          ? count === condition.n
          : count < condition.n)
      );
    }
    default:
      return condition satisfies never;
  }
}

function checkErrors(
  declaration: Declaration,
  act: SentAct,
  state: State,
): string[] {
  const open = state.open;
  const last = open?.acts.at(-1);
  const latest = (name: string) =>
    open?.acts.filter((earlier) => earlier.name === name).at(-1);
  return declaration.checks.flatMap(({ after, check }) => {
    if (after !== undefined && last?.name !== after) {
      return [];
    }
    switch (check.kind) {
      case "number-in": {
        const items = listItems(latest(check.act)?.values.get(check.q));
        const numbers = items.map((item) => /^\s*(\d+)/u.exec(item)?.[1]);
        return numbers.includes((act.values.get(check.p) ?? "").trim())
          ? []
          : [`:${check.p} is not a number in the latest ${check.act}`];
      }
      case "matches-accepted": {
        if (last?.name !== "accept-proposal") {
          return [];
        }
        const option = (last.values.get("option") ?? "").trim();
        const offered = listItems(
          latest("propose")?.values.get("options"),
        ).find((item) => /^\s*(\d+)/u.exec(item)?.[1] === option);
        return offered !== undefined &&
          slotKey(offered) === slotKey(act.values.get(check.p) ?? "")
          ? []
          : [`:${check.p} is not the accepted option`];
      }
      case "item-count": {
        const count = listItems(act.values.get(check.p)).length;
        return count >= check.min && count <= check.max
          ? []
          : [
              `:${check.p} has ${String(count)} items, not ${String(check.min)} to ${String(check.max)}`,
            ];
      }
      case "items-in-latest": {
        const offered = new Set(
          listItems(latest(check.act)?.values.get(check.q)).map(
            (entry) => /^\s*(\d+)/u.exec(entry)?.[1],
          ),
        );
        const value = act.values.get(check.p) ?? "";
        const isList =
          value.trim() === "none" || /^\[.*\]$/u.test(value.trim());
        return isList && numbersOf(value).every((n) => offered.has(n))
          ? []
          : [`:${check.p} names an item not in the latest ${check.act}`];
      }
      case "number-in-every": {
        const n = (act.values.get(check.p) ?? "").trim();
        const answers = latestPerSender(open, check.act);
        return answers.length > 0 &&
          answers.every((e) => numbersOf(e.values.get(check.q)).includes(n))
          ? []
          : [`:${check.p} is not in every ${check.act}`];
      }
      case "none-in-every": {
        const answers = latestPerSender(open, check.act);
        const common = answers.reduce<string[] | undefined>((shared, e) => {
          const numbers = numbersOf(e.values.get(check.q));
          return shared === undefined
            ? numbers
            : shared.filter((n) => numbers.includes(n));
        }, undefined);
        return (common ?? []).length === 0
          ? []
          : [
              `some number is in every ${check.act}: ${(common ?? []).join(", ")}`,
            ];
      }
      case "matches-item": {
        const n = (act.values.get(check.q) ?? "").trim();
        const entry = listItems(latest(check.act)?.values.get(check.r)).find(
          (e) => /^\s*(\d+)/u.exec(e)?.[1] === n,
        );
        return entry !== undefined &&
          slotKey(entry) === slotKey(act.values.get(check.p) ?? "")
          ? []
          : [`:${check.p} is not item ${n} of the latest ${check.act}`];
      }
      case "equals-latest":
        return slotKey(act.values.get(check.p) ?? "") ===
          slotKey(latest(check.act)?.values.get(check.q) ?? "\u0000")
          ? []
          : [`:${check.p} differs from :${check.q} of the latest ${check.act}`];
      case "is-number":
        return (act.values.get(check.p) ?? "").trim() === String(check.n)
          ? []
          : [`:${check.p} is not ${String(check.n)}`];
      case "one-more": {
        const previous = Number(latest(check.act)?.values.get(check.q));
        return Number(act.values.get(check.p)) === previous + 1
          ? []
          : [
              `:${check.p} is not one more than :${check.q} of the latest ${check.act}`,
            ];
      }
      case "none-or-number-in": {
        const value = (act.values.get(check.p) ?? "").trim();
        const numbers = listItems(latest(check.act)?.values.get(check.q)).map(
          (item) => /^\s*(\d+)/u.exec(item)?.[1],
        );
        return !act.values.has(check.p) ||
          value === "none" ||
          numbers.includes(value)
          ? []
          : [
              `:${check.p} is neither none nor a number in the latest ${check.act}`,
            ];
      }
      case "greater": {
        const value = Number(act.values.get(check.p));
        return Number.isNaN(value) || value > Number(act.values.get(check.q))
          ? []
          : [`:${check.p} is not greater than :${check.q}`];
      }
      case "largest-since": {
        const given = (
          open === undefined ? undefined : actsSince(open, check.since)
        )
          ?.filter((e) => e.name === check.act)
          .map((e) => Number(e.values.get(check.q)))
          .filter((n) => !Number.isNaN(n));
        return given !== undefined &&
          given.length > 0 &&
          Number(act.values.get(check.p)) === Math.max(...given)
          ? []
          : [
              `:${check.p} is not the largest :${check.q} of the ${check.act} since the latest ${check.since}`,
            ];
      }
      case "within-every": {
        const slot = rangeOf(act.values.get(check.p) ?? "");
        const lists = latestPerSender(open, check.act).map((e) =>
          rangesOf(e.values.get(check.q)),
        );
        return slot !== undefined &&
          lists.length > 0 &&
          lists.every((ranges) =>
            ranges.some(
              (range) =>
                range.day === slot.day &&
                range.start <= slot.start &&
                slot.end <= range.end,
            ),
          )
          ? []
          : [`:${check.p} does not lie within an item of every ${check.act}`];
      }
      case "no-range-in-every": {
        const lists = latestPerSender(open, check.act).map((e) =>
          rangesOf(e.values.get(check.q)),
        );
        return commonSlotExists(lists, lengthOf(open))
          ? [`some slot lies within an item of every ${check.act}`]
          : [];
      }
      case "ends-with":
        return (act.values.get(check.p) ?? "").trim().endsWith(check.suffix)
          ? []
          : [`:${check.p} does not end with ${check.suffix}`];
      case "present-when": {
        const present = act.values.has(check.p);
        const expected = (act.values.get(check.q) ?? "").trim() === check.value;
        return present === expected
          ? []
          : [
              `:${check.p} must appear exactly when :${check.q} is ${check.value}`,
            ];
      }
      default:
        return check satisfies never;
    }
  });
}

/** The way `act` may be sent now, if any. */
function matchingWhen(
  declaration: Declaration | undefined,
  act: SentAct,
  state: State,
  idParameter: string,
): Condition[] | undefined {
  return declaration?.when.find((conditions) =>
    conditions.every((condition) => holds(condition, act, state, idParameter)),
  );
}

/** Apply a replayed act to the conversation's requests. */
function apply(
  declaration: Declaration | undefined,
  act: SentAct,
  state: State,
  idParameter: string,
): void {
  const kinds = new Set(
    (matchingWhen(declaration, act, state, idParameter) ?? []).map(
      (condition) => condition.kind,
    ),
  );
  const id = act.values.get(idParameter) ?? "";
  if (kinds.has("resend") && state.open !== undefined) {
    state.open.resent = true;
    return;
  }
  if (kinds.has("opens")) {
    const request: Request = { id, acts: [act], resent: false };
    state.requests.set(id, request);
    state.open = request;
    return;
  }
  if (kinds.has("answers") && state.open !== undefined) {
    state.open.acts.push(act);
    if (kinds.has("final")) {
      state.open.closedBy = act.name;
      state.open = undefined;
    }
    return;
  }
  state.requests.get(id)?.acts.push(act);
}

/**
 * Build the experimental state check for one protocol rule.
 * @param options The middleware id and the rule whose text declares the acts' states.
 * @returns Middleware usable in either direction of `makeFirewall`.
 */
export function makeProtocolState(options: {
  readonly id: string;
  readonly rule: RuleDescription & { readonly text: string };
}): MessageMiddleware {
  const declarations = declaredStates(options.rule.text);
  const idParameter =
    /id in :([a-z-]+)/u.exec(options.rule.text)?.[1] ?? "request";
  const { id, kind, guidance, feedback } = options.rule;
  const actOf = (message: {
    readonly text: string;
    readonly sender: string;
    readonly recipients: readonly string[];
  }): SentAct | undefined => {
    const parsed = parseAct(message.text);
    return typeof parsed === "string"
      ? undefined
      : {
          name: parsed.name,
          values: new Map(parsed.values),
          sender: message.sender,
          recipients: message.recipients,
        };
  };
  return {
    id: options.id,
    revision: "protocol-state-v3",
    rules: [{ id, kind, guidance, feedback }],
    check: (input: MiddlewareInput) =>
      Effect.sync(() => {
        const state: State = { requests: new Map() };
        for (const entry of input.context.history) {
          const act = entry.admission === "admitted" ? actOf(entry) : undefined;
          if (act !== undefined) {
            apply(declarations.get(act.name), act, state, idParameter);
          }
        }
        const candidate = actOf(input.event.message);
        const declaration =
          candidate === undefined
            ? undefined
            : declarations.get(candidate.name);
        const errors =
          candidate === undefined || declaration === undefined
            ? []
            : [
                ...(matchingWhen(declaration, candidate, state, idParameter) ===
                undefined
                  ? [`${candidate.name} may not be sent at this point`]
                  : []),
                ...checkErrors(declaration, candidate, state),
              ];
        const result: MiddlewareResult = {
          findings: [
            {
              ruleId: id,
              outcome:
                errors.length === 0
                  ? "pass"
                  : input.event.direction === "incoming"
                    ? "block"
                    : "revise",
            },
          ],
          expectations: [],
          trace: {
            format: "protocol-state/v2",
            data: JSON.stringify({ errors }),
          },
        };
        return result;
      }),
  };
}
