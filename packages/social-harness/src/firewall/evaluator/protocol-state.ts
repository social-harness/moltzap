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
  | { readonly kind: "matches-accepted"; readonly p: string }
  | {
      readonly kind: "item-count";
      readonly p: string;
      readonly min: number;
      readonly max: number;
    }
  | { readonly kind: "ends-with"; readonly p: string; readonly suffix: string }
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
      check.kind === "number-in" ? [check.p] : [],
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
  const actOf = (text: string, sender: string): SentAct | undefined => {
    const parsed = parseAct(text);
    return typeof parsed === "string"
      ? undefined
      : { name: parsed.name, values: new Map(parsed.values), sender };
  };
  return {
    id: options.id,
    revision: "protocol-state-v2",
    rules: [{ id, kind, guidance, feedback }],
    check: (input: MiddlewareInput) =>
      Effect.sync(() => {
        const state: State = { requests: new Map() };
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
            format: "protocol-state/v2",
            data: JSON.stringify({ errors }),
          },
        };
        return result;
      }),
  };
}
