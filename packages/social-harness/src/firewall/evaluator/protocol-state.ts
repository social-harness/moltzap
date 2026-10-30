/**
 * @file Experiment: checks the conversation state of structured protocol
 * messages in code. The protocol text declares, under each act, "when" lines
 * (alternative conditions for sending it) and "check" lines (mechanical
 * checks on its values) in a fixed vocabulary; this check replays the
 * conversation's acts against those declarations and refuses a message the
 * declarations do not allow. What values mean is left to the decision
 * provider.
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
  | { readonly kind: "opens" | "answers" | "final" | "unprompted" }
  | { readonly kind: "names-escalated" }
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
  | { readonly kind: "time-order"; readonly p: string }
  | {
      readonly kind: "no-shared-slot";
      readonly p: string;
      readonly act: string;
    }
  | { readonly kind: "matches-accepted"; readonly p: string };

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
  if (
    part === "opens" ||
    part === "answers" ||
    part === "final" ||
    part === "unprompted"
  ) {
    return { kind: part };
  }
  if (part === "names an escalated request") {
    return { kind: "names-escalated" };
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
  const order = /^:([a-z-]+) is in time order$/u.exec(part);
  if (order !== null) {
    return { kind: "time-order", p: order[1] ?? "" };
  }
  const shared =
    /^:([a-z-]+) shares no slot with the previous ([a-z-]+)$/u.exec(part);
  if (shared !== null) {
    return { kind: "no-shared-slot", p: shared[1] ?? "", act: shared[2] ?? "" };
  }
  const accepted = /^:([a-z-]+) matches the accepted option$/u.exec(part);
  if (accepted !== null) {
    return { kind: "matches-accepted", p: accepted[1] ?? "" };
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
    const when = /^\s+when (.+)$/u.exec(line);
    if (when !== null && current !== undefined) {
      current.when.push(
        (when[1] ?? "")
          .split(";")
          .map(parseCondition)
          .filter((condition) => condition !== undefined),
      );
      continue;
    }
    const check = /^\s+check (?:after ([a-z-]+): )?(.+)$/u.exec(line);
    if (check !== null && current !== undefined) {
      const parsed = parseCheck(check[2] ?? "");
      if (parsed !== undefined) {
        current.checks.push({ after: check[1], check: parsed });
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
  readonly sent: Array<{ readonly sender: string; readonly key: string }>;
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

/** Minutes since the start of the year for a "<day> <date> <start>–<end> PM" slot, if it parses. */
function slotStart(slot: string): number | undefined {
  const match =
    /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?[^a-z]*?(am|pm)/iu.exec(
      slotKey(slot),
    );
  if (match === null) {
    return undefined;
  }
  const month = months.indexOf((match[1] ?? "").toLowerCase());
  if (month < 0) {
    return undefined;
  }
  const meridiem = (match[5] ?? match[6] ?? "").toLowerCase();
  let hour = Number(match[3]) % 12;
  if (meridiem === "pm") {
    hour += 12;
  }
  return (
    ((month * 31 + Number(match[2])) * 24 + hour) * 60 + Number(match[4] ?? "0")
  );
}

const canonical = (act: {
  name: string;
  values: ReadonlyMap<string, string>;
}) => JSON.stringify([act.name, [...act.values].sort()]);

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
      return (
        open !== undefined &&
        open.acts.filter((earlier) => earlier.name === condition.act).length ===
          condition.n
      );
    case "count-below":
      return (
        open !== undefined &&
        open.acts.filter((earlier) => earlier.name === condition.act).length <
          condition.n
      );
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
      default:
        return check satisfies never;
    }
  });
}

/**
 * The reasons `act` may not be sent now. `undefined` declarations mean the
 * act is unknown, which the form check reports.
 */
function stateErrors(
  declarations: ReadonlyMap<string, Declaration>,
  act: SentAct,
  state: State,
  idParameter: string,
): string[] {
  const declaration = declarations.get(act.name);
  if (declaration === undefined) {
    return [];
  }
  const open = state.open;
  const opener = open?.acts[0];
  const isResend =
    opener !== undefined &&
    opener.sender === act.sender &&
    canonical(opener) === canonical(act);
  if (isResend) {
    return open?.resent === true ? ["a second resend of the open request"] : [];
  }
  const key = canonical(act);
  if (
    state.sent.some(
      (earlier) => earlier.sender === act.sender && earlier.key === key,
    )
  ) {
    return ["repeats an act its sender already sent"];
  }
  const allowed = declaration.when.some((conditions) =>
    conditions.every((condition) => holds(condition, act, state, idParameter)),
  );
  return [
    ...(allowed ? [] : [`${act.name} may not be sent at this point`]),
    ...checkErrors(declaration, act, state),
  ];
}

/** Apply an act's declared effects to the replayed state. */
function apply(
  declarations: ReadonlyMap<string, Declaration>,
  act: SentAct,
  state: State,
  idParameter: string,
): void {
  const declaration = declarations.get(act.name);
  const id = act.values.get(idParameter) ?? "";
  const opener = state.open?.acts[0];
  if (
    opener !== undefined &&
    opener.sender === act.sender &&
    canonical(opener) === canonical(act) &&
    state.open !== undefined
  ) {
    state.open.resent = true;
    return;
  }
  state.sent.push({ sender: act.sender, key: canonical(act) });
  const conditions =
    (declaration?.when ?? []).find((line) =>
      line.every((condition) => holds(condition, act, state, idParameter)),
    ) ??
    declaration?.when[0] ??
    [];
  const kinds = new Set(conditions.map((condition) => condition.kind));
  if (kinds.has("opens")) {
    const request: Request = { id, acts: [act], resent: false };
    state.requests.set(id, request);
    state.open = request;
    return;
  }
  const named = state.requests.get(id);
  if (kinds.has("answers") && state.open !== undefined) {
    state.open.acts.push(act);
    if (kinds.has("final")) {
      state.open.closedBy = act.name;
      state.open = undefined;
    }
    return;
  }
  named?.acts.push(act);
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
    revision: "protocol-state-v0",
    rules: [{ id, kind, guidance, feedback }],
    check: (input: MiddlewareInput) =>
      Effect.sync(() => {
        const state: State = { requests: new Map(), sent: [] };
        for (const entry of input.context.history) {
          const act =
            entry.admission === "admitted"
              ? actOf(entry.text, entry.sender)
              : undefined;
          if (act !== undefined) {
            apply(declarations, act, state, idParameter);
          }
        }
        const candidate = actOf(
          input.event.message.text,
          input.event.message.sender,
        );
        const errors =
          candidate === undefined
            ? []
            : stateErrors(declarations, candidate, state, idParameter);
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
            format: "protocol-state/v0",
            data: JSON.stringify({ errors }),
          },
        };
        return result;
      }),
  };
}
