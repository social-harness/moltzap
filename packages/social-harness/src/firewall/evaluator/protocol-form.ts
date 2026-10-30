/**
 * @file Experiment: checks the form of structured protocol messages in code.
 * The protocol text itself declares its roles and its acts, each act as
 * `(name` followed by `:parameter description` lines; this check parses those
 * declarations, then refuses any message that is not exactly one declared act
 * with exactly its declared parameters, or whose sender uses acts of two roles.
 * Meaning, timing and values beyond a declared `one of` list are left to the
 * decision provider.
 */

import { Effect } from "effect";
import type {
  MessageMiddleware,
  MiddlewareInput,
  MiddlewareResult,
  RuleDescription,
} from "./contract/index.js";

interface Parameter {
  readonly optional: boolean;
  readonly allowed?: readonly string[];
}

interface Act {
  readonly role: string;
  readonly parameters: ReadonlyMap<string, Parameter>;
}

/** The acts a protocol text declares, keyed by name. */
export function declaredActs(protocol: string): ReadonlyMap<string, Act> {
  const acts = new Map<string, Act>();
  let role: string | undefined;
  let current: { name: string; parameters: Map<string, Parameter> } | undefined;
  for (const line of protocol.split("\n")) {
    const section = /^acts sent by the (\S+)/u.exec(line);
    if (section !== null) {
      role = section[1];
      continue;
    }
    const start = /^\s+\(([a-z][a-z-]*)\s*$/u.exec(line);
    if (start !== null && role !== undefined) {
      current = { name: start[1] ?? "", parameters: new Map() };
      continue;
    }
    const parameter = /^\s+:([a-z][a-z-]*)\s+(.*?)\s*(\))?\s*$/u.exec(line);
    if (parameter !== null && current !== undefined && role !== undefined) {
      const description = parameter[2] ?? "";
      const oneOf = /one of ([^:;]+)/u.exec(description);
      current.parameters.set(parameter[1] ?? "", {
        optional: description.startsWith("optional"),
        allowed: oneOf?.[1]
          ?.split(/,\s*|\s+or\s+/u)
          .map((value) => value.trim())
          .filter((value) => value !== ""),
      });
      if (parameter[3] !== undefined) {
        acts.set(current.name, { role, parameters: current.parameters });
        current = undefined;
      }
    }
  }
  return acts;
}

interface Parsed {
  readonly name: string;
  readonly values: ReadonlyArray<readonly [string, string]>;
}

/** One act in the declared form, or the reason the text is not one. */
export function parseAct(text: string): Parsed | string {
  const trimmed = text.trim();
  const match = /^\(([a-z][a-z-]*)\s*\n([\s\S]*)\)$/u.exec(trimmed);
  if (match === null) {
    return "not exactly one act";
  }
  const values: Array<readonly [string, string]> = [];
  for (const line of (match[2] ?? "").split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const parameter = /^\s*:([a-z][a-z-]*)\s+(.+?)\s*$/u.exec(line);
    if (parameter === null) {
      return "a line that is not one parameter";
    }
    values.push([parameter[1] ?? "", parameter[2] ?? ""]);
  }
  return { name: match[1] ?? "", values };
}

/** The reasons `text` breaks the declared form for a sender playing `role`. */
function formErrors(
  acts: ReadonlyMap<string, Act>,
  text: string,
  senderRoles: ReadonlySet<string>,
): string[] {
  const parsed = parseAct(text);
  if (typeof parsed === "string") {
    return [parsed];
  }
  const act = acts.get(parsed.name);
  if (act === undefined) {
    return [`unknown act ${parsed.name}`];
  }
  const errors: string[] = [];
  if (senderRoles.size > 0 && !senderRoles.has(act.role)) {
    errors.push(`${parsed.name} is a ${act.role} act`);
  }
  const seen = new Set<string>();
  for (const [name, value] of parsed.values) {
    const parameter = act.parameters.get(name);
    if (parameter === undefined) {
      errors.push(`unknown parameter ${name}`);
    } else if (seen.has(name)) {
      errors.push(`parameter ${name} twice`);
    } else if (
      parameter.allowed !== undefined &&
      !parameter.allowed.includes(value)
    ) {
      errors.push(`${name} is not one of ${parameter.allowed.join(", ")}`);
    }
    seen.add(name);
  }
  for (const [name, parameter] of act.parameters) {
    if (!parameter.optional && !seen.has(name)) {
      errors.push(`missing parameter ${name}`);
    }
  }
  return errors;
}

/**
 * The role each participant plays, from the acts it already sent: a sender's
 * role is whichever role declares the acts in its history. A participant
 * whose history spans two roles, or two participants claiming one role, plays
 * none.
 */
function rolesFromHistory(
  acts: ReadonlyMap<string, Act>,
  input: MiddlewareInput,
): ReadonlyMap<string, ReadonlySet<string>> {
  const roles = new Map<string, Set<string>>();
  for (const entry of input.context.history) {
    if (entry.admission !== "admitted") {
      continue;
    }
    const parsed = parseAct(entry.text);
    const act = typeof parsed === "string" ? undefined : acts.get(parsed.name);
    if (act !== undefined) {
      const known = roles.get(entry.sender) ?? new Set<string>();
      known.add(act.role);
      roles.set(entry.sender, known);
    }
  }
  return roles;
}

/**
 * Build the experimental form check for one protocol rule.
 * @param options The middleware id, the rule whose text declares the acts,
 *   and the id its findings use.
 * @returns Middleware usable in either direction of `makeFirewall`.
 */
export function makeProtocolForm(options: {
  readonly id: string;
  readonly rule: RuleDescription & { readonly text: string };
}): MessageMiddleware {
  const acts = declaredActs(options.rule.text);
  const { id, kind, guidance, feedback } = options.rule;
  return {
    id: options.id,
    revision: "protocol-form-v0",
    rules: [{ id, kind, guidance, feedback }],
    check: (input) =>
      Effect.sync(() => {
        const { message } = input.event;
        const history = rolesFromHistory(acts, input);
        const own = history.get(message.sender) ?? new Set<string>();
        const others = [...history.entries()]
          .filter(([sender]) => sender !== message.sender)
          .flatMap(([, roles]) => [...roles]);
        const claimed = new Set(
          [...acts.values()]
            .map((act) => act.role)
            .filter((role) => !others.includes(role)),
        );
        const senderRoles = own.size > 0 ? own : claimed;
        const errors = [
          ...formErrors(acts, message.text, senderRoles),
          ...(own.size > 1 ? ["sender's earlier acts span two roles"] : []),
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
            format: "protocol-form/v0",
            data: JSON.stringify({ errors }),
          },
        };
        return result;
      }),
  };
}
