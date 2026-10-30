/**
 * @file Experiment: one complete office-hours protocol, as a single norm in
 * Prof. Mahajan's agent's enforcement-mode firewall, judged against real
 * messages from the CSE 561 pilot in both directions. Prints each case's
 * judgment beside the one the protocol calls for. Needs a Jev key in the
 * file named by `JEV_KEY_FILE`.
 */

import { readFileSync } from "node:fs";
import { it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import { messagePolicyFirewall } from "../policy/compose.js";
import { decodeMessagePolicy } from "../policy/index.js";
import { makeFirewall, makeTextPolicy } from "./index.js";
import { makeJevDecisionProvider } from "./jev.js";

const PROF = "agt_professor";
const STUDENT = "agt_student_tapan";

const PROTOCOL = `Prof. Mahajan's agent books CSE 561 office hours for students' agents over Social Harness. This rule governs every message between Prof. Mahajan's agent and a student's agent, in both directions; each part names whose messages it governs.

Messages a student's agent sends to Prof. Mahajan's agent: each is exactly one of (a) a request to book office hours that names the student, the student's UW email and a topic; (b) a request to move or cancel that student's own booking; (c) a question about that student's own booking; (d) an answer to the question Prof. Mahajan's agent last asked, which may be only the answer itself; (e) an acceptance of exactly one option from Prof. Mahajan's agent's latest offer, or "none of these" with what did not work. Anything else breaks this rule: thanks, acknowledgements, status updates, notices that it is waiting or has told its student something, messages meant to be relayed to the student, a booking request that leaves out the student's name, UW email or topic, and any request about a different student's booking.

Messages Prof. Mahajan's agent sends to a student's agent: each answers that agent's latest open request exactly once. It either confirms a booking, move or cancellation that has been made (with the day, the time in Pacific time and the student's name), offers up to three open slots, asks for exactly the required items that are missing, refuses with only the reason category, or says the calendar did not answer and nothing changed. When a request names the student, the UW email and a topic, it does not ask what the student meant; it offers or books. After two rounds of offers the student did not accept, it says it is asking Prof. Mahajan instead of offering again. It never names another student, never describes another event on his calendar or why a time is busy, and never recites the office-hours terms.`;

const POLICY = {
  format: "org.social-harness/message-policy/v2",
  mode: "enforcement",
  text: {
    fixedRules: [
      {
        id: "cse561-office-hours",
        kind: "norm",
        text: PROTOCOL,
        guidance:
          "Follow Prof. Mahajan's office-hours protocol: requests carry the student's name, UW email and topic; replies give one outcome per request; no status messages.",
        feedback: {
          text: "This message does not follow Prof. Mahajan's office-hours protocol.",
          nextAction: "revise",
        },
      },
    ],
  },
  decisionProvider: { kind: "jev", model: "jev-1.13.0" },
};

interface Turn {
  readonly from: "prof" | "student";
  readonly text: string;
}

interface Case {
  readonly name: string;
  readonly direction: "incoming" | "outgoing";
  readonly history: readonly Turn[];
  readonly text: string;
  /** What the protocol calls for: admitted, or rejected (withheld incoming, refused outgoing). */
  readonly expected: "admit" | "reject";
}

const REQUEST =
  "Office-hours request for Tapan Chugh (tapanc@uw.edu): I'd like help with my TCP congestion control project.";

const CASES: readonly Case[] = [
  {
    name: "complete booking request",
    direction: "incoming",
    history: [],
    text: REQUEST,
    expected: "admit",
  },
  {
    name: "request missing the email",
    direction: "incoming",
    history: [],
    text: "Tapan would like to discuss TCP/IP. Could you share open office-hours slots? UW email not provided yet.",
    expected: "reject",
  },
  {
    name: "status / acknowledgement",
    direction: "incoming",
    history: [
      { from: "student", text: REQUEST },
      {
        from: "prof",
        text: "The calendar did not answer; nothing changed. Try again in a few minutes.",
      },
    ],
    text: "Thanks—I've relayed the calendar blocker and that nothing was booked to Tapan.",
    expected: "reject",
  },
  {
    name: "waiting notice",
    direction: "incoming",
    history: [{ from: "student", text: REQUEST }],
    text: "I'm checking with Tapan whether he already has an office-hours invitation under another email before confirming. I'll get back to you.",
    expected: "reject",
  },
  {
    name: "answer to his question",
    direction: "incoming",
    history: [
      { from: "student", text: REQUEST },
      { from: "prof", text: "Which UW email should the invitation go to?" },
    ],
    text: "tapanc@uw.edu",
    expected: "admit",
  },
  {
    name: "reschedule own booking",
    direction: "incoming",
    history: [
      { from: "student", text: REQUEST },
      {
        from: "prof",
        text: "Booked Tapan Chugh: Tue Nov 3, 2:00–2:15 PM PT, TCP congestion control.",
      },
    ],
    text: "Tapan asks to move his booking on Tuesday, November 3, 2:00–2:15 PM PT to a later slot that day.",
    expected: "admit",
  },
  {
    name: "accept one offered option",
    direction: "incoming",
    history: [
      { from: "student", text: REQUEST },
      {
        from: "prof",
        text: "Open: 1) Tue Nov 3, 2:00 PM, 2) Tue Nov 3, 2:15 PM, 3) Thu Nov 5, 3:00 PM.",
      },
    ],
    text: "Tapan takes option 2, Tue Nov 3, 2:15 PM.",
    expected: "admit",
  },
  {
    name: "claim on another student's slot",
    direction: "incoming",
    history: [],
    text: "Maya Chen cancelled her Tue Nov 3, 2:30 PM booking and asked that it go to Riley Shah (rshah@uw.edu), topic HW3.",
    expected: "reject",
  },
  {
    name: "his booking confirmation",
    direction: "outgoing",
    history: [{ from: "student", text: REQUEST }],
    text: "Booked Tapan Chugh: Tue Nov 3, 2:00–2:15 PM PT, TCP congestion control. Google sent the invitation to tapanc@uw.edu.",
    expected: "admit",
  },
  {
    name: "his offer of three slots",
    direction: "outgoing",
    history: [{ from: "student", text: REQUEST }],
    text: "Open: 1) Tue Nov 3, 2:00 PM, 2) Tue Nov 3, 2:15 PM, 3) Thu Nov 5, 3:00 PM PT. Which one?",
    expected: "admit",
  },
  {
    name: "he recites his terms",
    direction: "outgoing",
    history: [{ from: "student", text: REQUEST }],
    text: "CSE 561 office hours are Tuesdays and Thursdays, 2–4 PM America/Los_Angeles, in 15-minute slots, one student per free slot. No availability has been confirmed yet.",
    expected: "reject",
  },
  {
    name: "he names another student",
    direction: "outgoing",
    history: [
      {
        from: "student",
        text: "Tapan Chugh (tapanc@uw.edu) would like Tue Nov 3, 2:30 PM for TCP/IP.",
      },
    ],
    text: "Tue 2:30 PM is taken by Maya Chen. Open: Tue 2:45 PM, Thu 3:00 PM.",
    expected: "reject",
  },
  {
    name: "he asks what a complete request meant",
    direction: "outgoing",
    history: [{ from: "student", text: REQUEST }],
    text: "Are you requesting an office-hours booking for Tapan, or asking about availability?",
    expected: "reject",
  },
  {
    name: "third offer instead of escalating",
    direction: "outgoing",
    history: [
      { from: "student", text: REQUEST },
      {
        from: "prof",
        text: "Open: 1) Tue 2:00 PM, 2) Tue 2:15 PM, 3) Thu 3:00 PM.",
      },
      {
        from: "student",
        text: "None of these: Tapan is busy Tuesday and Thursday afternoons.",
      },
      {
        from: "prof",
        text: "Open: 1) Thu 3:30 PM, 2) Thu 3:45 PM, 3) Tue 3:45 PM.",
      },
      {
        from: "student",
        text: "None of these: Tapan can't do any afternoon this week.",
      },
    ],
    text: "Open: 1) Tue Nov 10, 2:00 PM, 2) Tue Nov 10, 2:15 PM, 3) Thu Nov 12, 3:00 PM.",
    expected: "reject",
  },
];

function contextOf(c: Case) {
  return {
    agentId: PROF,
    principal: "prn_professor",
    participants: [
      { agentId: PROF, principal: "prn_professor" },
      { agentId: STUDENT, principal: "prn_student" },
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

/** Runs only when a Jev key file is named, so the unit suite never calls Jev. */
const live = process.env.JEV_KEY_FILE === undefined ? it.live.skip : it.live;

live(
  "one office-hours protocol rule, judged both ways on pilot messages",
  () =>
    Effect.gen(function* () {
      const provider = makeJevDecisionProvider({
        apiKey: Redacted.make(
          readFileSync(process.env.JEV_KEY_FILE ?? "", "utf8").trim(),
        ),
        model: "jev-1.13.0",
      });
      const policy = yield* decodeMessagePolicy(JSON.stringify(POLICY));
      const options = yield* messagePolicyFirewall(policy, provider);
      const text = yield* makeTextPolicy({
        id: "owner",
        rules: options.text?.fixedRules ?? [],
        provider,
        settings: options.text?.settings,
      });
      const firewall = yield* makeFirewall({
        incoming: [...options.incoming, text],
        outgoing: [...options.outgoing, text],
        settings: options.settings,
      });
      const rows = yield* Effect.forEach(
        CASES,
        (c) =>
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
            const got = result.judgment === "allow" ? "admit" : "reject";
            const notice = result.feedback.map((entry) => entry.text).join(" ");
            return `${got === c.expected ? "PASS" : "FAIL"}  ${c.direction.padEnd(8)}  expected ${c.expected.padEnd(6)} got ${result.judgment.padEnd(6)}  ${c.name}${notice === "" ? "" : `\n      notice: ${notice}`}`;
          }),
        { concurrency: 4 },
      );
      const passed = rows.filter((row) => row.startsWith("PASS")).length;
      console.log(
        [
          "",
          ...rows,
          `${String(passed)}/${String(rows.length)} as the protocol calls for`,
        ].join("\n"),
      );
    }),
  600_000,
);
