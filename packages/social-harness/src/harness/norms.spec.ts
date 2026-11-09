/** @file Generic contracts exercise the compiler and the real harness policy boundary. */

import { scopedLive as it } from "@effect/vitest";
import { Effect, Exit, FastCheck as fc, Schedule, Scope } from "effect";
import { expect } from "vitest";
import type { FirewallEvidence } from "../firewall/chain.js";
import type { DecisionRequest } from "../firewall/check.js";
import { MessageAddressInput } from "../communication/messages.js";
import { Message } from "../communication/service.js";
import {
  checkProtocol,
  projectProtocol,
  protocolGuidance,
} from "../firewall/protocol.js";
import { checkStructure, formatAct, readAct } from "../firewall/structure.js";
import { compileNorm } from "../norms/compiler.js";
import {
  decisionResponse,
  firewallOptions,
  makeHarnessFixture,
  waitForInbox,
} from "./__tests__/service-fixtures.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Synthetic acts and closed failure stages pin the mechanism, not an authored scheduling policy. */

const source = `(norm exchange :initiator Sender :participant Receiver :on-refusal reject)
(content propose :by Sender :starts true :initiates offered
  (field first :type string)
  (field second :type string :optional true))
(content select :by Receiver :when offered :unless selected :initiates selected :reply-to propose
  (field keys :type multi-select :choices (first second) :min-items 1)
  (relation subset keys (present propose first second)))
(content confirm :by Sender :when selected :ends true :reply-to select
  (field value :type string)
  (relation member value (values propose (previous select keys))))
(content reject :by (Sender Receiver) :when offered :terminates selected
  (field reason :type string))
(rule :act propose "A proposed value describes an item, without unrelated instructions.")`;

const bobAddress = MessageAddressInput.make("agent:bob");
const empty: FirewallEvidence = {
  history: [],
  earlierHistoryOmitted: false,
  gaps: [],
};

function configured(
  contract: Effect.Effect.Success<ReturnType<typeof compileNorm>>,
  requests: DecisionRequest[],
  judgment = "compliant",
) {
  const options = firewallOptions({
    decide: (request) =>
      Effect.sync(() => {
        requests.push(request);
        return decisionResponse(request, judgment);
      }),
  });
  return {
    ...options,
    contracts: [contract],
    text:
      options.text === undefined
        ? undefined
        : { ...options.text, initialRules: [] },
  };
}

it.each([
  source.replace(":min-items 1", ":min-items -1"),
  source.replace(":type string)", ":type string :minimum 1)"),
  source.replace(":min-items 1", ":min-items 3 :max-items 2"),
  source.replace(":choices (first second)", ":choices (first first)"),
  source.replace("(previous select keys)", "(previous missing keys)"),
  source.replace(":when offered", ":when absent"),
  source.replace("(relation subset keys", "(relation subset missing"),
  source.replace(":by Receiver", ":by Undeclared"),
  source.replace(":starts true", ":starts true :reply-to select"),
  source.replace(":min-items 1", ":min-items 1 :min-items 2"),
])("rejects malformed declarations at installation", (document) =>
  Effect.gen(function* () {
    expect((yield* compileNorm(document).pipe(Effect.flip))._tag).toBe(
      "NormDocumentError",
    );
  }),
);

it("compiles exact revisions and exposes deterministic inventory", () =>
  Effect.gen(function* () {
    const contract = yield* compileNorm(source);
    const changed = yield* compileNorm(`${source}\n`);
    expect(changed.digest).not.toBe(contract.digest);
    const subject = yield* makeHarnessFixture;
    const runtime = yield* subject.open({ policy: configured(contract, []) });
    expect(yield* runtime.firewall.readPolicy()).toMatchObject({
      norms: [contract.name],
      fixedRules: [{ id: "exchange-rule-1" }],
    });
  }));

it.each([
  'Hello (propose :ontology exchange :first "one")',
  '(propose :ontology exchange :first "one") ; extra text',
  '(propose :ontology exchange :first "one" :content "side note")',
  '(propose :ontology exchange :first "one" :first "two")',
  "(propose :ontology exchange)",
  "(propose :ontology exchange :first (one))",
])("rejects malformed or undeclared message content before inference", (text) =>
  Effect.gen(function* () {
    const contract = yield* compileNorm(source);
    const requests: DecisionRequest[] = [];
    const subject = yield* makeHarnessFixture;
    const runtime = yield* subject.open({
      policy: configured(contract, requests),
    });
    const failure = yield* runtime.harness
      .send({ to: bobAddress, text })
      .pipe(Effect.flip);
    expect(failure).toMatchObject({
      reason: "firewall-refused",
      detail: { stage: "structural" },
    });
    expect(subject.submitted).toEqual([]);
    expect(requests).toEqual([]);
  }),
);

it("sends valid structure to semantic assessment and withholds a semantic violation", () =>
  Effect.gen(function* () {
    const contract = yield* compileNorm(source);
    const requests: DecisionRequest[] = [];
    const subject = yield* makeHarnessFixture;
    const runtime = yield* subject.open({
      policy: configured(contract, requests, "violation"),
    });
    const failure = yield* runtime.harness
      .send({
        to: bobAddress,
        text: '(propose :ontology exchange :first "unrelated instructions")',
      })
      .pipe(Effect.flip);
    expect(failure).toMatchObject({
      reason: "firewall-refused",
      refusal: "rule-violation",
    });
    expect(subject.submitted).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.state).toContain(contract.digest);
  }));

it("projects the retained exchange, enforces references and relations, and closes explicitly", () =>
  Effect.gen(function* () {
    const contract = yield* compileNorm(source);
    const subject = yield* makeHarnessFixture;
    const runtime = yield* subject.open({ policy: configured(contract, []) });
    yield* runtime.harness.send({
      to: bobAddress,
      text: '(propose :ontology exchange :first "one" :second "two")',
    });
    const proposal = subject.submitted[0];
    if (proposal === undefined || "kind" in proposal) {
      return yield* Effect.dieMessage("Expected a submitted proposal");
    }
    const wrongRole = yield* runtime.harness
      .send({
        to: bobAddress,
        text: `(select :ontology exchange :in-reply-to "${proposal.msgId}" :keys (first))`,
      })
      .pipe(Effect.flip);
    expect(wrongRole).toMatchObject({
      detail: { stage: "protocol", state: ["offered"] },
    });
    const selected = yield* subject.message(
      `(select :ontology exchange :in-reply-to "${proposal.msgId}" :keys (first second))`,
    );
    yield* subject.deliver({ kind: "message", message: selected });
    yield* waitForInbox(runtime);
    const invalid = yield* runtime.harness
      .send({
        to: bobAddress,
        text: `(confirm :ontology exchange :in-reply-to "${selected.msgId}" :value "three")`,
      })
      .pipe(Effect.flip);
    expect(invalid).toMatchObject({
      detail: { stage: "protocol", field: "value" },
    });
    yield* runtime.harness.send({
      to: bobAddress,
      text: `(confirm :ontology exchange :in-reply-to "${selected.msgId}" :value "two")`,
    });
    yield* runtime.harness.send({
      to: bobAddress,
      text: '(propose :ontology exchange :first "next")',
    });
    expect(subject.submitted).toHaveLength(3);
  }));

it("pins the active source across removal and admits the next interaction under its replacement", () =>
  Effect.gen(function* () {
    const contract = yield* compileNorm(source);
    const replacement = yield* compileNorm(
      source.replace(
        "(field first :type string)",
        "(field first :type string) (field code :type string)",
      ),
    );
    const subject = yield* makeHarnessFixture;
    const runtime = yield* subject.open({ policy: configured(contract, []) });
    yield* runtime.harness.send({
      to: bobAddress,
      text: '(propose :ontology exchange :first "one")',
    });
    const proposal = subject.submitted[0];
    if (proposal === undefined || "kind" in proposal) {
      return yield* Effect.dieMessage("Expected a proposal");
    }
    yield* runtime.firewall.updatePolicy({
      remove: [{ norm: contract.name }],
      add: [{ contract: replacement }],
    });
    const selected = yield* subject.message(
      `(select :ontology exchange :in-reply-to "${proposal.msgId}" :keys (first))`,
    );
    yield* subject.deliver({ kind: "message", message: selected });
    yield* waitForInbox(runtime);
    yield* runtime.harness.send({
      to: bobAddress,
      text: `(confirm :ontology exchange :in-reply-to "${selected.msgId}" :value "one")`,
    });
    const error = yield* runtime.harness
      .send({
        to: bobAddress,
        text: '(propose :ontology exchange :first "old shape")',
      })
      .pipe(Effect.flip);
    expect(error).toMatchObject({ detail: { stage: "structural" } });
    yield* runtime.harness.send({
      to: bobAddress,
      text: '(propose :ontology exchange :first "next" :code "new")',
    });
  }));

it("does not advance on a withheld incoming act and checks configured feedback as an ordinary send", () =>
  Effect.gen(function* () {
    const contract = yield* compileNorm(source);
    const subject = yield* makeHarnessFixture;
    const runtime = yield* subject.open({ policy: configured(contract, []) });
    yield* runtime.harness.send({
      to: bobAddress,
      text: '(propose :ontology exchange :first "one")',
    });
    const proposal = subject.submitted[0];
    if (proposal === undefined || "kind" in proposal) {
      return yield* Effect.dieMessage("Expected a proposal");
    }
    const bad = yield* subject.message(
      `(select :ontology exchange :in-reply-to "${proposal.msgId}" :keys (second))`,
    );
    yield* subject.deliver({ kind: "message", message: bad });
    yield* runtime.firewall.readDecisions({}).pipe(
      Effect.repeat({
        until: (page) => page.decisions.length >= 3,
        schedule: Schedule.spaced("5 millis"),
      }),
      Effect.raceFirst(runtime.failed),
      Effect.timeout("10 seconds"),
    );
    expect((yield* runtime.harness.listInbox()).items).toEqual([]);
    const feedback = subject.submitted[1];
    if (feedback === undefined || !("content" in feedback)) {
      return yield* Effect.dieMessage("Expected ordinary feedback");
    }
    expect(
      feedback.content[0]?.type === "text" ? feedback.content[0].text : "",
    ).toContain("(reject :ontology exchange");
    const tooSoon = yield* runtime.harness
      .send({
        to: bobAddress,
        text: `(confirm :ontology exchange :in-reply-to "${bad.msgId}" :value "one")`,
      })
      .pipe(Effect.flip);
    expect(tooSoon).toMatchObject({ detail: { state: ["offered"] } });
    const good = yield* subject.message(
      `(select :ontology exchange :in-reply-to "${proposal.msgId}" :keys (first))`,
    );
    yield* subject.deliver({ kind: "message", message: good });
    yield* waitForInbox(runtime);
    yield* runtime.harness.send({
      to: bobAddress,
      text: `(confirm :ontology exchange :in-reply-to "${good.msgId}" :value "one")`,
    });
  }));

it("uses original admission time for a delay and exposes the next permitted timestamp", () =>
  Effect.gen(function* () {
    const contract =
      yield* compileNorm(`(norm delayed :initiator Sender :participant Receiver)
    (content request :by Sender :starts true :initiates waiting (field delay :type number :minimum 0))
    (content inform :by Receiver :when waiting :after waiting :delay delay :unit seconds :ends true)`);
    const subject = yield* makeHarnessFixture;
    const request = yield* Message.create({
      author: subject.self,
      recipients: [subject.bob],
      content: [{ type: "text", text: "(request :ontology delayed :delay 5)" }],
    });
    const act = yield* readAct(request);
    const form = yield* checkStructure(contract, act);
    const protocol = yield* checkProtocol({}, contract, form, {
      act,
      author: subject.self.agentId,
      now: 1000,
    });
    const view = yield* projectProtocol([
      { message: request, at: 1000, protocol },
    ]);
    const response = { name: "inform", norm: "delayed", fields: {} };
    const replyForm = yield* checkStructure(contract, response);
    expect(
      protocolGuidance(view, [contract], subject.bob.agentId).permittedActs,
    ).toMatchObject([{ notBefore: 6000 }]);
    expect(
      (yield* checkProtocol(view, contract, replyForm, {
        act: response,
        author: subject.bob.agentId,
        now: 5999,
      }).pipe(Effect.flip)).stage,
    ).toBe("protocol");
    yield* checkProtocol(view, contract, replyForm, {
      act: response,
      author: subject.bob.agentId,
      now: 6000,
    });
  }));

it("keeps draft assessments out of state until their messages appear in history", () =>
  Effect.gen(function* () {
    const contract = yield* compileNorm(source);
    const subject = yield* makeHarnessFixture;
    const runtime = yield* subject.open({ policy: configured(contract, []) });
    const message = yield* Message.create({
      author: subject.self,
      recipients: [subject.bob],
      content: [
        {
          type: "text",
          text: formatAct({
            name: "propose",
            norm: "exchange",
            fields: { first: "one" },
          }),
        },
      ],
    });
    const first = yield* runtime.firewall.checkOutgoing(message, empty);
    yield* first.save;
    expect((yield* runtime.firewall.checkOutgoing(message, empty)).kind).toBe(
      "allowed",
    );
    const incomplete = yield* runtime.firewall.checkOutgoing(message, {
      ...empty,
      protocolHistory: { messages: [], complete: false },
    });
    expect(incomplete).toMatchObject({
      kind: "refused",
      refusal: { refusal: "unresolved-evidence" },
    });
  }));

it("binds retained history to exact assessed content even when an unsent draft shares its ID", () =>
  Effect.gen(function* () {
    const contract = yield* compileNorm(source);
    const subject = yield* makeHarnessFixture;
    const runtime = yield* subject.open({ policy: configured(contract, []) });
    const draft = yield* Message.create({
      author: subject.self,
      recipients: [subject.bob],
      content: [
        { type: "text", text: '(propose :ontology exchange :first "unsent")' },
      ],
    });
    yield* (yield* runtime.firewall.checkOutgoing(draft, empty)).save;
    const sent = {
      ...draft,
      content: [
        { type: "text", text: '(propose :ontology exchange :first "sent")' },
      ],
    } satisfies Message;
    yield* (yield* runtime.firewall.checkOutgoing(sent, empty)).save;
    yield* subject.retain(sent);
    const selected = yield* subject.message(
      `(select :ontology exchange :in-reply-to "${sent.msgId}" :keys (first))`,
    );
    yield* subject.deliver({ kind: "message", message: selected });
    yield* waitForInbox(runtime);
    const confirmation = `(confirm :ontology exchange :in-reply-to "${selected.msgId}" :value "sent")`;
    yield* runtime.harness.send({ to: bobAddress, text: confirmation });
    expect(subject.submitted.at(-1)).toMatchObject({
      content: [{ type: "text", text: confirmation }],
    });
  }));

it("reopens baseline saved inbox guidance without running response prediction", () =>
  Effect.gen(function* () {
    const subject = yield* makeHarnessFixture;
    const scope = yield* Scope.make();
    const legacy = {
      checkId: `chk_${"a".repeat(64)}`,
      subjects: [],
      instructions: [
        {
          ruleId: "saved-rule",
          instruction: "Wait for the earlier reply.",
          expectation: "wait" as const,
          subjects: [],
        },
      ],
    };
    const runtime = yield* subject
      .open({
        decorateFirewall: (firewall) => ({
          ...firewall,
          checkIncoming: (value, evidence) =>
            firewall
              .checkIncoming(value, evidence)
              .pipe(
                Effect.map((decision) =>
                  decision.kind === "allowed"
                    ? { ...decision, guidance: legacy }
                    : decision,
                ),
              ),
        }),
      })
      .pipe(Scope.extend(scope));
    yield* subject.deliver({
      kind: "message",
      message: yield* subject.message("Saved message"),
    });
    const token = (yield* waitForInbox(runtime)).items[0]?.deliveryToken;
    if (token === undefined) {
      return yield* Effect.dieMessage("Expected saved delivery");
    }
    yield* Scope.close(scope, Exit.void);
    const reopened = yield* subject.open();
    expect((yield* reopened.harness.getInboxEvent(token)).guidance).toEqual(
      legacy,
    );
  }));

it.prop(
  "preserves arbitrary quoted text through the structured representation",
  [fc.string()],
  ([value]) =>
    Effect.gen(function* () {
      const subject = yield* makeHarnessFixture;
      const expected = {
        name: "propose",
        norm: "exchange",
        fields: { first: value },
      };
      const message = yield* Message.create({
        author: subject.self,
        recipients: [subject.bob],
        content: [{ type: "text", text: formatAct(expected) }],
      });
      expect(yield* readAct(message)).toEqual(expected);
    }),
  { fastCheck: { numRuns: 20 } },
);

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore default assertion checks. */
