/**
 * @file Calibration run: judges every case in `OH_CASES` (JSONL) against the
 * rule text in `OH_RULE`, `OH_RUNS` times each, and writes one JSONL line per
 * judgment to `OH_RESULTS` with the provider's probability of a violation.
 * `OH_CHECK` picks the one-call verdict check (`verdict`, the default) or the
 * staged text policy (`staged`). Needs a Jev key in the file named by
 * `JEV_KEY_FILE`; skipped otherwise.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import {
  type FirewallCheck,
  makeFirewall,
  makeTextPolicy,
  TextRule,
} from "./index.js";
import { makeJevDecisionProvider } from "./jev.js";
import { makeProtocolCheck } from "./protocol-check.js";

const PROF = "agt_Q7mZr2LkVx9pTb4nWc1hYs";
const STUDENT = "agt_d3FjK8uNe5RtA0gHqP6yMw";

const FIREWALL_SETTINGS = {
  timeoutMilliseconds: 120_000,
  middlewareTimeoutMilliseconds: 60_000,
  maximumInputBytes: 2_000_000,
  maximumResultBytes: 2_000_000,
};

const TEXT_SETTINGS = {
  minimumProbability: 0.5,
  maximumRequestBytes: 384_000,
  timeoutMilliseconds: 30_000,
};

interface Case {
  readonly id: string;
  readonly direction: "incoming" | "outgoing";
  readonly history: ReadonlyArray<{
    readonly from: "prof" | "student";
    readonly text: string;
  }>;
  readonly text: string;
}

function contextOf(c: Case) {
  return {
    agentId: PROF,
    principal: "prn_Hc2Wq9Ls0Xa7Ve4Rn1Bt5k",
    participants: [
      { agentId: PROF, principal: "prn_Hc2Wq9Ls0Xa7Ve4Rn1Bt5k" },
      { agentId: STUDENT, principal: "prn_m8Ty3Gd6Jp1Zu0Ks7Ef2Qx" },
    ],
    history: c.history.map((turn, index) => ({
      id: `msg_${String(index)}`,
      sender: turn.from === "prof" ? PROF : STUDENT,
      recipients: [turn.from === "prof" ? STUDENT : PROF] as [string],
      text: turn.text,
      visibility: "runtime" as const,
      admission: "admitted" as const,
    })),
    facts: [],
    gaps: [],
  };
}

/** The provider's probability of a violation, from whichever check ran. */
function violationProbability(result: FirewallCheck): number | undefined {
  const data = result.checks[0]?.trace?.data;
  if (data === undefined) {
    return undefined;
  }
  const trace = JSON.parse(data) as {
    answers?: Record<string, { probabilities: Record<string, number> }>;
    stages?: ReadonlyArray<{
      stage: string;
      response?: {
        answers: Record<string, { probabilities: Record<string, number> }>;
      };
    }>;
  };
  if (trace.answers !== undefined) {
    return trace.answers["verdict-0"]?.probabilities["violation"];
  }
  const conformance = trace.stages?.find(
    (stage) => stage.stage === "conformance",
  );
  return conformance?.response?.answers["q0"]?.probabilities["violation"];
}

const configured =
  process.env.JEV_KEY_FILE !== undefined &&
  process.env.OH_CASES !== undefined &&
  process.env.OH_RULE !== undefined &&
  process.env.OH_RESULTS !== undefined;

/** Runs only when a Jev key and the calibration files are named. */
const live = configured ? it.live : it.live.skip;

live(
  "calibrates the office-hours rule against a labelled case file",
  () =>
    Effect.gen(function* () {
      const provider = makeJevDecisionProvider({
        apiKey: Redacted.make(
          readFileSync(process.env.JEV_KEY_FILE ?? "", "utf8").trim(),
        ),
        model: "jev-1.13.0",
      });
      const rule = new TextRule({
        id: "cse561-office-hours",
        kind: "norm",
        text: readFileSync(process.env.OH_RULE ?? "", "utf8").trim(),
        feedback: {
          text: "This message does not follow Prof. Mahajan's office-hours protocol.",
          nextAction: "revise",
        },
      });
      const check =
        process.env.OH_CHECK === "staged"
          ? yield* makeTextPolicy({
              id: "owner",
              rules: [rule],
              provider,
              settings: TEXT_SETTINGS,
            })
          : makeProtocolCheck({ id: "protocol", rules: [rule], provider });
      const firewall = yield* makeFirewall({
        incoming: [check],
        outgoing: [check],
        settings: FIREWALL_SETTINGS,
      });
      const cases = readFileSync(process.env.OH_CASES ?? "", "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Case);
      const runs = Number(process.env.OH_RUNS ?? "5");
      const output = process.env.OH_RESULTS ?? "";
      writeFileSync(output, "");
      const jobs = cases.flatMap((c) =>
        Array.from({ length: runs }, (_, run) => ({ c, run })),
      );
      yield* Effect.forEach(
        jobs,
        ({ c, run }) =>
          Effect.gen(function* () {
            const message = {
              id: "msg_candidate",
              sender: c.direction === "outgoing" ? PROF : STUDENT,
              recipients: [c.direction === "outgoing" ? STUDENT : PROF] as [
                string,
              ],
              text: c.text,
            };
            const result = yield* c.direction === "outgoing"
              ? firewall.checkOutgoing(message, contextOf(c))
              : firewall.checkIncoming(message, contextOf(c));
            appendFileSync(
              output,
              `${JSON.stringify({
                id: c.id,
                run,
                judgment: result.judgment,
                reason: result.reason,
                pViolation: violationProbability(result) ?? null,
              })}\n`,
            );
          }),
        { concurrency: 8 },
      );
    }),
  3_600_000,
);
