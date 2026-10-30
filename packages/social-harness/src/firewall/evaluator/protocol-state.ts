/**
 * @file Experiment: checks the conversation state of structured protocol
 * messages in code. Under each act the protocol text declares "when" lines
 * (alternative conditions for sending it), "check" lines (mechanical checks on
 * its values) and "effect" lines (how it changes the Student's bookings), in
 * the fixed vocabulary its "state" section defines. This check replays the
 * conversation's acts against those declarations and refuses a message they
 * do not allow. What values mean is left to the decision provider.
 */

import { Effect } from "effect";
import type {
  MessageMiddleware,
  MiddlewareInput,
  MiddlewareResult,
  RuleDescription,
} from "./contract/index.js";
import { parseAct } from "./protocol-form.js";

type Condition =
  | {
      readonly kind:
        | "opens"
        | "resend"
        | "answers"
        | "final"
        | "unprompted"
        | "names-escalated";
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
  | {
      readonly kind: "time-order" | "matches-accepted" | "booked";
      readonly p: string;
    }
  | {
      readonly kind: "no-shared-slot";
      readonly p: string;
      readonly act: string;
    }
  | {
      readonly kind: "present-when";
      readonly p: string;
      readonly q: string;
      readonly value: string;
    };

type Change =
  | { readonly kind: "books" | "unbooks"; readonly p: string }
  | { readonly kind: "unbooks-opener"; readonly p: string };

interface Declaration {
  readonly when: Condition[][];
  readonly checks: Array<{ readonly after?: string; readonly check: Check }>;
  readonly effects: Change[];
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
    default:
      break;
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
  const simple =
    /^:([a-z-]+) (is in time order|matches the accepted option|is booked)$/u.exec(
      part,
    );
  if (simple !== null) {
    const kinds = {
      "is in time order": "time-order",
      "matches the accepted option": "matches-accepted",
      "is booked": "booked",
    } as const;
    return {
      kind: kinds[simple[2] as keyof typeof kinds],
      p: simple[1] ?? "",
    };
  }
  const shared =
    /^:([a-z-]+) shares no slot with the previous ([a-z-]+)$/u.exec(part);
  if (shared !== null) {
    return { kind: "no-shared-slot", p: shared[1] ?? "", act: shared[2] ?? "" };
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

function parseEffect(text: string): Change | undefined {
  const part = text.trim();
  const opener = /^unbooks the request's :([a-z-]+)$/u.exec(part);
  if (opener !== null) {
    return { kind: "unbooks-opener", p: opener[1] ?? "" };
  }
  const change = /^(books|unbooks) :([a-z-]+)$/u.exec(part);
  if (change !== null) {
    return {
      kind: change[1] === "books" ? "books" : "unbooks",
      p: change[2] ?? "",
    };
  }
  return undefined;
}

/** The "when", "check" and "effect" lines a protocol text declares under each act. */
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
      current = { when: [], checks: [], effects: [] };
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
      continue;
    }
    const effect = /^\s+effect (.+)$/u.exec(line);
    if (effect !== null) {
      const parsed = parseEffect(effect[1] ?? "");
      if (parsed !== undefined) {
        current.effects.push(parsed);
      }
    }
  }
  return declarations;
}

interface SentAct {
  readonly name: string;
  readonly values: ReadonlyMap<string, string>;
  readonly sender: string;
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
  /** The Student's bookings, keyed by their start. */
  readonly bookings: Set<string>;
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

const months = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

/** Minutes into the year at which a "<day> <month> <date> <start>[–<end>] AM|PM" slot starts, if it parses. */
function slotStart(slot: string): number | undefined {
  const match =
    /([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?[^a-z]*?(am|pm)/u.exec(
      slotKey(slot),
    );
  if (match === null) {
    return undefined;
  }
  const month = months.indexOf(match[1] ?? "");
  if (month < 0) {
    return undefined;
  }
  const hour =
    (Number(match[3]) % 12) + ((match[5] ?? match[6]) === "pm" ? 12 : 0);
  return (
    ((month * 31 + Number(match[2])) * 24 + hour) * 60 + Number(match[4] ?? "0")
  );
}

const startKey = (slot: string | undefined) => {
  const start = slot === undefined ? undefined : slotStart(slot);
  return start === undefined ? undefined : String(start);
};

const canonical = (act: SentAct) =>
  JSON.stringify([act.sender, act.name, [...act.values].sort()]);

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
      case "time-order": {
        const starts = listItems(act.values.get(check.p)).map(slotStart);
        if (starts.some((start) => start === undefined)) {
          return [];
        }
        return starts.every(
          (start, index) =>
            index === 0 || (starts[index - 1] ?? 0) <= (start ?? 0),
        )
          ? []
          : [`:${check.p} is not in time order`];
      }
      case "no-shared-slot": {
        const previous = new Set(
          listItems(latest(check.act)?.values.get(check.p)).map(slotKey),
        );
        return listItems(act.values.get(check.p)).some((item) =>
          previous.has(slotKey(item)),
        )
          ? [`:${check.p} repeats a slot of the previous ${check.act}`]
          : [];
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
      case "booked": {
        const key = startKey(act.values.get(check.p));
        return key !== undefined && state.bookings.has(key)
          ? []
          : [`:${check.p} names none of the Student's bookings`];
      }
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

/** Apply an act's declared effects to the replayed state. */
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
  const opener = state.open?.acts[0];
  for (const change of declaration?.effects ?? []) {
    const key = startKey(
      change.kind === "unbooks-opener"
        ? opener?.values.get(change.p)
        : act.values.get(change.p),
    );
    if (key === undefined) {
      continue;
    }
    if (change.kind === "books") {
      state.bookings.add(key);
    } else {
      state.bookings.delete(key);
    }
  }
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
  const actOf = (text: string, sender: string): SentAct | undefined => {
    const parsed = parseAct(text);
    return typeof parsed === "string"
      ? undefined
      : { name: parsed.name, values: new Map(parsed.values), sender };
  };
  return {
    id: options.id,
    revision: "protocol-state-v1",
    rules: [{ id, kind, guidance, feedback }],
    check: (input: MiddlewareInput) =>
      Effect.sync(() => {
        const state: State = { requests: new Map(), bookings: new Set() };
        for (const entry of input.context.history) {
          const act =
            entry.admission === "admitted"
              ? actOf(entry.text, entry.sender)
              : undefined;
          if (act !== undefined) {
            apply(declarations.get(act.name), act, state, idParameter);
          }
        }
        const candidate = actOf(
          input.event.message.text,
          input.event.message.sender,
        );
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
            format: "protocol-state/v1",
            data: JSON.stringify({ errors }),
          },
        };
        return result;
      }),
  };
}
