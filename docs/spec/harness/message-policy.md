# Message policy execution

Status: **experimental runtime implementation; broader real-agent qualification
pending**

This chapter defines the experimental semantic checks of the endpoint's
personal firewall (L3 Personal Firewalls).
[Endpoint screening](./screening.md) owns its structural checks. Client
assesses application messages before outgoing intent publication and
incoming runtime admission. The evaluator separates safety
from contextual norms. Norm violations return actionable send errors; incoming
items carry local guidance about whether to respond and what to address.

Both middleware chains live in Client, with one interface for code and English
policies. Local norm guidance stays distinct from peer content, and a withheld
message returns actionable send-call feedback. Owner-authority tools edit
English rules and activate policy in process.

Owner approval is norm guidance that asks the agent to ask its owner through
its host, for example with `ask_user`; see [shared norms](../norms.md).

`sharnessd` installs the firewall a [message-policy file](#message-policy-file)
describes in the daemon's incoming and outgoing message paths.
`@moltzap/client/service` also exposes the standalone evaluator and
`Daemon.withFirewall(options)`, which installs a trusted composition's own
chains. Code and English policies implement the same
`MessageMiddleware` interface. An installation captures fixed code and English rules, owner facts, settings
and provider/model provenance before the listener opens. Editable English rules
are restored from the daemon store.
Without a message-policy file, `Daemon.layer`, which `sharnessd` runs, is the
baseline composition without message checks.

See [firewall/admission/firewall.ts](https://github.com/social-harness/moltzap/blob/main/packages/client/src/firewall/admission/firewall.ts) →
`collectiveAdmission` and
[harness/inbox/host-delivery.ts](https://github.com/social-harness/moltzap/blob/main/packages/client/src/harness/inbox/host-delivery.ts) →
`makeHostDelivery` with
[firewall/admission/admission.ts](https://github.com/social-harness/moltzap/blob/main/packages/client/src/firewall/admission/admission.ts) →
`runAdmission` for the outgoing and incoming flows. The standalone runner
remains usable by offline experiments without acquiring a daemon or store.

## Ownership and scope

Client owns context construction, admission, retained dispositions and recovery.
History admission and runtime visibility are independent. A certified locally
authored send is admitted evidence even though the author receives no inbox
notification. Such history remains assessor-only unless independently admitted
to the runtime; it cannot become a subject in host-visible guidance. A held
incoming message remains withheld evidence.
The firewall consumes an explicit message and context. Its middleware receives
no host, signing, store or messaging capability; the optional English adapter
calls an injected decision provider. Registered code is trusted in-process code,
not sandboxed JavaScript. Adapters only project the result.

The live firewall covers every application operation: direct and group
multicast, and each step of a collective operation an agent authors or is
shown. [Collective operations](#collective-operations) states where each step
is checked. Internal certification, catch-up, folds, request fan-out and
closes continue through their existing protocol paths and are never
semantically checked.

The threat model is adversarial peers communicating with an endpoint whose
composition is controlled by its operator. It does not claim isolation from a
compromised privileged host.

## Composition interfaces

These values belong to service composition, not the agent-facing endpoint.

| Capability | Contract |
| --- | --- |
| Message middleware | Stable id, revision, declared rule descriptions, and `check(input)` returning an Effect of per-rule findings, norm expectations and optional private trace. Code and English policies share this contract. |
| English policy | `makeEnglishPolicy` freezes English documents, templates and settings and returns middleware. It interprets text through a provider; it does not generate executable policy code. |
| Message and context | Exact candidate and direction, and the collective operation it belongs to; local agent and principal identity; verified participant attribution; authorized earlier history, owner facts, evidence gaps and the capture time. Context is data, not another service. |
| Decision provider | State and named bounded-choice questions to validated distributions, provider/model identity, usage and latency, or a typed operational failure. Names of external providers/models remain data. |
| Firewall | `makeFirewall({ incoming, outgoing, settings })` returns `checkIncoming(message, context)` and `checkOutgoing(draft, context)`. The runner validates and composes all returned findings and projects registered guidance/feedback. |
| Client admission state | Retain the assessment and atomically compare candidate, policy and evidence versions before runtime admission or outgoing intent creation. Freshness is private Client state; there is no public Snapshot or Binding service. |

Evaluator construction is exposed through the existing service composition
subpath so offline experiments can exercise the same code. It is not a new
method on HarnessEndpoint and does not introduce a new npm package.

Native and MCP schemas and error decoding change together. Client and adapter
versions are deployed together and use the current schemas directly. Peer wire
formats remain unchanged.

## Middleware execution

Each direction installs an ordered list of middleware, which may be empty. The runner copies
and freezes registration metadata and input data, then supplies each check with
the original event, context and earlier validated observations. Those observations
exclude private traces. There is no middleware-owned `next()` callback.

Every declared rule must return a finding. A local `pass` or `not-applicable`
cannot erase another finding. Code and English checks have identical weight and
the same rule-reference, visibility and feedback validation. Conflicting response
expectations hold for review. Full static execution continues after rejection
within per-middleware and total attempt budgets.

A middleware result is atomic. Completed results survive a later failure;
an outer timeout cannot recover unreturned internal findings. English middleware
catches typed provider failures and defects per stage, preserving completed
stages. Exhausted total budgets mark remaining checks unavailable. Cancellation
interrupts the attempt rather than producing an admission result. These deadlines
are cooperative; in-process trusted code is not a process-isolation boundary.

The English middleware runs this fixed internal chain:

1. Use the captured message, context and frozen English rules.
2. Assess applicability across every active document. The first implementation
   records relevance but does not prune active rules.
3. Assess safety: compliant, prohibited or unresolved for each safety rule.
4. Assess norm expectations: required response, permitted response, wait or no
   response, with selected rule and subject references.
5. For outgoing messages, assess the candidate's conformance to the
   expectations the decision provider settled.
6. Return all stage findings and a private trace to the common runner for
   validation, composition and permitted feedback projection. Client then commits
   the result and applies the configured admission mode.

All configured stages run even after a semantic rejection, except that a
dependent stage with invalid input is explicitly unavailable. Diagnostics never
override a rejection. Missing required evidence in the context, invalid output
and provider failure cannot produce admission; an uncertain norm judgment admits
as described below. They remain distinct in the retained check.

An answer is uncertain when its choice is `unresolved`, its probability is
below `minimumProbability`, or another option is more probable, as in a rounded
near-tie the policy accepts as valid. An uncertain answer about a safety rule
holds the candidate, its applicability included, and a failed decision
provider holds it in every stage. Applicability labels never prune active rules. Making
applicability optional is a later experiment; increasing history length can
increase holds even when the central safety answer is clear.

An uncertain answer about a norm rule never holds the candidate, in
applicability, expectations or conformance:

- a norm whose applicability is uncertain is still assessed by expectations
  and conformance;
- an uncertain expectation is left out of the norms conformance assesses, and an
  uncertain subject reference is left out of its expectation;
- an uncertain applicability, expectation or conformance answer is a `pass`
  finding with reason `uncertain`, the decision provider's choice and its
  probability, both recorded in the retained check; and
- each uncertain finding whose rule registers guidance reaches the agent as an
  instruction carrying the rule, that choice and probability, and the rule's
  guidance.

Provider probabilities use one tolerance of 0.02 for their sum and for the
stated choice's distance from the maximum. The evaluator retains distributions
unchanged; a choice below the maximum remains uncertain.

A settled judgment keeps its effect: a conformance violation still asks for
revision, and a settled expectation still becomes guidance.

No model call runs inside a database transaction, the delivery semaphore or
Router consumption. A stale result is reassessed within a bounded refresh
budget or held. Provider timeouts and cancellation are explicit.

The initial bounded catalog and authorized history are supplied in full within
the configured budget. Required omitted context causes a hold. Retrieval
pruning, summaries and caching are later experiments.

Outgoing expectations exclude the draft's text and id. Conformance sees the draft only after expectations
are established from the original evidence. The question edition and rules are
part of the English revision; provider/model identity is captured in immutable installation provenance before
inference, including attempts that fail or are interrupted. Experiment manifests
also pin the requested provider/model.

The English middleware checks each visible message's relevance to each norm
independently. Several references can anchor one instruction. This increases
question count with history length; a serialized request byte budget holds an
oversized request without truncating it. That budget is not a tokenizer or a
guarantee of fitting a provider's context window. Provider limit failures hold
the candidate too. Renderer-only guidance and feedback are excluded from the
assessment rules sent to the model.

Each English request states the authenticated-attribution and evidence-handling
instructions once in `state.instructions`. Every assessment and subject question
starts its instructions with `Apply state.instructions first. `, followed by
question-specific instructions. State also supplies every rule's text once.
Questions refer to rule ids, and subject questions identify the message being
assessed.

## Incoming projection

The existing delivery envelope carries optional local guidance beside its
InboundItem, which is the original item, except that an admitted collective
result is its [local projection](#collective-projection). Guidance replaces
no peer content.

The guidance of one checked message or request contains:

- response expectation: required, permitted, wait or none;
- subject references to runtime-visible messages or operations;
- selected runtime-visible English instructions; and
- for each norm judgment the decision provider left uncertain, its rule, the
  decision provider's choice and probability, and the rule's instruction.

A collective result's guidance is a list with one such entry per checked
answer that drew advice, each naming the member and its own check, and one for
the question when the question was checked with the result.

The guidance is locally attributed, not part of a peer's signed content. Its
references and text must come from supplied, authorized values. Neither private
assessor evidence nor peer instructions may be elevated into local guidance by
the firewall. An agent may hold `policy_update` when its owner's catalog lists
it. Peer text reaching that agent can lead to owner-rule edits; only `fixedRules` and
`fixedBehaviors` prevent those edits. See [Authority](../norms.md#authority).

Persist disposition and guidance before runtime exposure. Native subscriptions,
inbox pages, read-event and webhooks read the same admitted view; replay retains
the guidance and delivery identity. A held item cannot be retrieved through a
different runtime path. Owner-authorized history remains an audit capability.

Adapters use Client's [host text renderers](./client.md#public-values) for local
guidance and peer content.

A safe incoming message may arrive with guidance to remain silent. Guidance
does not force a response or establish a distributed speaking-turn protocol.
In enforcement mode, a held candidate's norm outputs are diagnostic only; they
create no runtime obligation and are not delivered instead of the message.

## Outgoing projection

`FirewallSendError` crosses the semantic send and MCP error boundaries. It
contains an opaque check reference, a reason and permitted feedback. Reasons
distinguish:

- prohibited message;
- unresolved required evidence;
- unavailable assessment;
- norm violation.

Feedback gives a useful next action: revise, wait, stop or seek approval.
The error's message includes each next action and the opaque check reference so
hosts retaining only text can act on the feedback and correlate a refusal with
the owner decisions feed. References use `chk_`
followed by 64 lowercase hexadecimal characters. Only that current format is
accepted; earlier retained guidance and refusal state requires a reset. The
message does not include raw provider output, credentials or private evidence.

Compose decisions in this order: known safety prohibition; required
operational/evidence hold; norm repair; otherwise admission.

An admitted send returns its check's guidance in its result when the check
left a norm judgment uncertain: the same instructions as incoming guidance,
without subjects. Settled outgoing expectations are not returned, since
conformance assessed the draft against them. The guidance is determined when the
check admits the send, so every result of that send carries it, including one
an all_gather's deadline produces before its group post certifies, and one
returned under `failureDelivery: "inbound"` when the send fails after admission,
for example as `delivery-pending`, and its error arrives as an
`operationFailed` item. The native and MCP
send results carry the same `guidance` field. Hosts expose it under the
[channel projection contract](./channels.md#adapter-messaging).

An error before admission means the candidate created no send intent. The agent
can revise and issue a new invocation, which runs the full chain. Client does
not rewrite the draft, automatically retry, wait for a human on the send call
or submit a later approval on the agent's behalf.

A fresh attempt after revision or new evidence is a new invocation. Once an intent is bound, existing
delivery-pending/outcome-unknown and protocol recovery semantics take over;
policy code cannot report that already pending send as an unsent refusal.

## State and protocol invariants

Capture and compare the exact candidate, recipients, policy digest and relevant
evidence versions. Comparison and new intent binding must share the admission
transaction; an asynchronous preflight check alone is insufficient.

Retain admission state separately from canonical records. Recovering a process
cannot admit a previously held item. Held items remain available for inspection.

Preserve incoming order with a retained per-conversation admission frontier.
Assess a successor after its predecessor's disposition settles, including a
settled hold; do not wait for a human release. Other conversations and protocol
processing remain independent. Restart restores the frontier before exposing
later items. An unfinished predecessor assessment is not missing evidence.

Protocol processing continues independently of local runtime admission.
Withheld peer statements are marked as such and cannot silently establish
obligations as though the runtime received them. Later items are assessed
against explicit visibility and evidence gaps.

Semantic assessment does not run in action/durability voting. Local disagreement
must not change shared history or the answers in a canonical all_gather result.

## Collective operations

Each endpoint's own firewall assesses what its agent asks for and what its agent
is shown, at the boundary between the host and Client's operations: the send
operation going out, and the admission worker coming in. It never checks the
collective protocol underneath. Group norms are the same installation on every
member, and each member decides independently.

### Outgoing collective checks

| Agent action | Checked candidate | Refusal |
| --- | --- | --- |
| Multicast | Its post | Nothing binds |
| all_gather | Its one group post | Nothing binds and the operation never starts: no deadline timer, no close |
| gather | The operation, once, before any request post | No request post binds and the operation never starts |
| Answer | Its response post, checked before the request is claimed | Nothing binds and the request stays open |

A gather's check commits in the transaction that compares its evidence, and
the committed check is the admitted operation: each request post binds only
against it, in its own transaction, and only with exactly the content the
check assessed. A gather's recipients are its members' verified cards, and its
evidence is the recent window of the conversation its address names.

An answer is checked before its request is claimed, so a close or the
deadline can still arrive during the check. Just before the answer binds,
Client matches its request again, still open in its conversation and before
its deadline, and claims it; when it no longer matches, the answer is refused
with its collective failure and nothing is sent; the check still commits,
withheld, so the retained check keeps its judgment. An all_gather opens, and its
deadline timer starts, just before its group post binds, and only when its
check admits it; the check's duration comes out of the deadline the agent
set, which is fixed in the checked content. A gather's check likewise
precedes its timer. A gather or all_gather whose deadline passes during its
check fails as `deadline-passed`, and nothing posts.

A gather's or all_gather's wait for its request posts runs from the send's
start, so time spent in its check shortens that wait. The check itself is
bounded only by the firewall's own timeouts, so a slow or saturated firewall
can still delay the call.

A firewall refusal is always the send's own failure, returned on the tool
call, even when the host routes failures inbound. Client never authors,
declines or retries on the agent's behalf.

### Incoming collective checks

| Item | Check |
| --- | --- |
| Request | Its question, exactly as the model reads it before the answer instructions, form included |
| Result | Each answer on its own, as its line of the result; the shell of members and outcomes is always admitted |
| Operation failure | None: the text is the endpoint's own, admitted under one deterministic audit record; a peer's form field names in it are quoted as JSON |
| Multicast | Unchanged |

A received request waits unanswerable until its admission settles: it cannot
be matched and does not count as answered. Shown, it opens; withheld, it
stays unanswerable, though an all_gather member still applies its close and
receives the result. A request whose deadline passes before its check starts
retires unchecked, and one whose deadline passes during its check is
withheld; neither is presented.

A result's answers are checked from one evidence capture, each against the
window of its own conversation before its certified record, and commit
together in one transaction. The endpoint's own answer and members without an
answer are not checked. An `invalid` outcome is checked too, since its reason
names peer-controlled fields. At a member the question is shown when the
runtime was shown the request, withheld under that check when an enforcing
check withheld the request, and otherwise checked with the result.

### Collective projection

The runtime reads a local projection of each admitted result; the canonical
result stays in the private queue and retained checks. Each withheld answer becomes
`{ kind: "withheld", checkId, reason }`, and a withheld question the same
value. Native subscriptions, inbox pages, read-event and webhooks all serve
only the projection. Guidance mode withholds nothing and attaches each
answer's advice.

Later checks see the operation as typed entries. A request record is
runtime-visible when its item reached the inbox, and an answer record when an
admitted result showed it; an answer a result withheld is marked withheld. An
admitted result or failure leaves a runtime-visible entry, attributed to
Social Harness, under its conversation's address, ordered after the records
certified before it was queued and before every record certified after. Each checked message names its operation, and
each context carries the time it was captured.

### Collective invariants

- No model call runs while a post is classified, during voting, under the
  delivery gate, or inside a store transaction.
- A check never changes certification, shared history or the canonical
  result an all_gather close lists; every member's canonical result stays
  identical, and only its local projection differs.
- Peer content reaches the runtime unchanged and attributed, or as an
  explicit `withheld` value; the firewall never turns peer content into
  guidance.
- A refusal is a typed send failure before any send intent binds.
- Hosts carry messages, guidance and errors only.
- A daemon with no firewall installed runs none of these checks: a
  received request opens at once, and every post binds as it is sent.

### Collective restart

Collective state is process-local, so restart loses it. A queued request the
runtime was never shown retires without a trace the agent can see; an
admitted request the agent has not acknowledged becomes an `operationFailed`
item, admitted as any failure is. A gather's request posts already bound may
still be proposed; members whose posts never bound are never posted. A check
interrupted by restart binds nothing.

## Runtime composition and persistence

Install trusted policy objects through the existing service layer:

```ts
import { Daemon } from "@moltzap/client/service";

const daemon = Daemon.withFirewall({
  mode: "enforcement",
  incoming: [fixedIncomingMiddleware],
  outgoing: [fixedOutgoingMiddleware],
  english: {
    fixedRules: fixedEnglishRules,
    initialRules: initialEditableRules,
    provider: jevProvider,
    settings: englishSettings,
  },
  settings,
  facts: ownerFacts,
  codeDigest: experimentCodeSha256,
  maximumHistoryRecords: 256, // Recent certified records per candidate conversation.
  maximumConcurrentChecks: 4,
});
```

The supplied code middleware, fixed English rules, provider, settings and facts
are captured for that process. `english` is optional; its `fixedRules` and
`initialRules` default to empty arrays. `initialRules` seeds only a missing
editable document, never an existing document, including an empty one.
`maximumHistoryRecords` sets the recent certified-record window per candidate
conversation in both directions (default 256, range 1–1024).
`codeDigest` is the operator's SHA-256 identifier for the experiment code; it is
recorded, not independently attested.

### Message-policy file

`SHARNESS_MESSAGE_POLICY_FILE` names a readable regular file containing a JSON
document of at most 1 MiB. `sharnessd` decodes it with `MessagePolicy` from
`@moltzap/client/service` and installs it through the same composition as
`Daemon.withFirewall`. Writers build
it with that schema. A trusted composition with its own decision provider
installs a decoded document with `messagePolicyFirewall(policy, provider)`.

```json
{
  "format": "org.social-harness/message-policy/v1",
  "mode": "enforcement",
  "incoming": [{ "use": "acknowledgements" }],
  "outgoing": [{ "use": "credentials" }, { "use": "plain-language", "toolNames": ["policy_read"] }],
  "english": { "fixedRules": [], "initialRules": [] },
  "decisionProvider": { "kind": "jev", "model": "jev-1.13.0" },
  "maximumConcurrentChecks": 2
}
```

| Property | Required | Value |
| --- | --- | --- |
| `format` | yes | `org.social-harness/message-policy/v1` |
| `mode` | yes | `guidance` or `enforcement`; a daemon without the file has no firewall |
| `incoming`, `outgoing` | no, default `[]` | built-in code middleware in chain order, below |
| `english` | no | `fixedRules` and `initialRules` as `EnglishRule` arrays, default `[]`, and `fixedBehaviors` and `initialBehaviors` as arrays of behavior directory paths, default `[]`; present, owner tools can edit English rules |
| `decisionProvider` | with `english` or the collective norms | `{kind: "jev", model}`, or `{kind: "unavailable"}` |
| `englishSettings` | no | `EnglishPolicySettings`; default probability 0.5, 384,000 request bytes, 15 s |
| `settings` | no | `FirewallSettings`; default 150 s per check, 70 s per middleware, 512,000 input bytes, 2,000,000 result bytes |
| `facts` | no, default `[]` | owner facts in every context |
| `maximumHistoryRecords`, `maximumConcurrentChecks` | no | as for `Daemon.withFirewall` |

The built-in middleware are trusted Client code; a document selects and
parameterizes them and adds no code:

| `use` | Direction | Middleware id | Rules |
| --- | --- | --- | --- |
| `acknowledgements` | incoming | `org.social-harness/acknowledgements` | `acknowledgement`: an exact empty acknowledgement, such as "Thanks", needs no response unless the agent's own later message asked its sender something |
| `allowed-senders` | incoming | `org.social-harness/allowed-senders` | `allowed-sender` (safety): blocks any certified sender outside `agentIds`; an empty list admits none |
| `credentials` | outgoing | `org.social-harness/credentials` | `credentials`: asks for revision of credential-shaped text or a labelled credential value other than a status word |
| `plain-language` | outgoing | `org.social-harness/plain-language` | `plain-language`: asks for revision of a plain send that carries raw JSON, a name in `toolNames`, a name starting with one of `toolNamePrefixes`, or a name in `invocationToolNames` formatted or invoked as a tool |
| `collective-norms` | both; outgoing names `facilitator` | `org.social-harness/collective-norms` | the collective norm bundle, below |

The collective norm bundle registers one middleware per direction under one
revision, the SHA-256 of its edition, both directions' English revisions and
the decision provider's provenance; the edition names the Client release, so
every release moves it. Its outgoing code rules are
`facilitator-starts-collectives`, `one-open-request` and
`no-acknowledgement-posts`; they run first, and the English rules
`one-gather`, `announce-once` and `result-settles` are assessed only when no
code rule refused the send. The incoming registration assesses those rules
and `acknowledgement`. The facilitator role is recorded in the outgoing
provenance, not the revision, so every member of a run registers the same
revision. The daemon logs each registration's id and revision at startup.

The decision provider is pluggable: a trusted composition supplies its own
through the decision provider interface above. `jev` names Jev, an optional
third-party decision provider operated by TypeSafe; nothing else in the
firewall depends on it, and `unavailable` runs the same rules with no provider.

A `jev` provider reads its key from `SHARNESS_DECISION_PROVIDER_KEY_FILE`,
ignoring surrounding whitespace, and retries an unreachable service, a rate
limit or a server error twice within each stage's timeout. `unavailable`
installs the English rules with no service, so every English check is
unavailable: enforcement holds the message and guidance admits it. Without
English rules or the collective norms, the provider and key are unused.

`codeDigest` is the SHA-256 of the Client release, the mode, each middleware's
id and revision (the allowed-senders list left out), the fixed English rules
and fixed behavior bytes (see [Behaviors](#behaviors)), the decision provider
and the settings. Initial rules and facts are left out,
so every member of an arm shares one digest.
Decoding refuses any property the format does not name, so a misspelled or
newer setting never silently weakens a policy: a writer adds a property only
once every daemon that reads its documents accepts it, and a reader accepts
every document an earlier release of this format accepted.

### Behaviors

An English rule can be written as an [agentbehavior.dev](https://agentbehavior.dev)
behavior: a directory holding exactly one behavior in a file named `BEHAVIOR.md`.
`fixedBehaviors` and `initialBehaviors` name such directories by paths relative
to the directory holding the policy file; absolute paths, `..`, and directory
or file symlinks escaping that directory are refused. `sharnessd` reads them
when it loads the file and installs each as a fixed or initial English rule,
after the inline ones. A composition can decode an inline-only document with
`decodeMessagePolicy` and pass it directly to `messagePolicyFirewall(decodedPolicy, provider)`.
`messagePolicyFirewall` refuses nonempty behavior paths with `CheckInputError`
(`registration`); file loading resolves those paths before composing the rules.
`Daemon.withFirewall` accepts the resulting firewall options.

```markdown
---
name: reach-out-hours
description: When the agent may start conversations.
metadata:
  social-harness:
    kind: safety
    feedback:
      text: Wait until working hours.
      nextAction: wait
---

Start no new conversation between 21:00 and 08:00 in the owner's time zone.
```

| Rule field | From `BEHAVIOR.md` |
| --- | --- |
| `id` | frontmatter `name` |
| `text` | the body, with surrounding whitespace removed |
| `kind` | `metadata.social-harness.kind`, default `norm` |
| `guidance` | `metadata.social-harness.guidance`, required for kind `norm` |
| `feedback` | `metadata.social-harness.feedback`, an `EnglishRule` feedback object |

`description`, `license`, other `metadata` keys and files beside `BEHAVIOR.md`
are not part of the rule. A key under `metadata.social-harness` other than
those three stops startup in phase `configuration`, as does a missing
directory, an invalid behavior, a behavior over 64 KiB, a fixed behavior whose
id repeats another fixed rule's, or a rule the editable-policy rules refuse. Each failure
names its path, such as `english.fixedBehaviors.0`, and a closed behavior reason:
`missing`, `too-large`, `not-a-file`, `frontmatter`, `schema`, `duplicate-id`, or
`editable-limit`, never file content.

Fixed behaviors are the composition's locked base: `policy_update` cannot
remove them. If a fixed behavior collides with a stored editable rule, remove
the editable rule with `policy_update` before enabling the behavior, or rename
the behavior. Initial behaviors are read and validated at every start, and seed
only a missing editable document, as `initialRules` do. `codeDigest` covers
each fixed behavior's `BEHAVIOR.md` bytes; initial behaviors are left out, as
initial rules are.

A [shared norm](../norms.md) is a behavior carried as message text, with no
directory. An agent maps it to a `Rule` itself and adds it with
`policy_update`; the file limits above do not apply to it.

### Editable English policy

The daemon owns a durable editable document of at most 256 rules. Each rule has
`{id, kind: "norm" | "safety", text, guidance?, feedback?}`;
`feedback` is `{text, nextAction}` as in `EnglishRule`. A norm requires a nonempty
`guidance` template. On load, persisted `autonomy` rules and message-policy
`english.fixedRules` and `initialRules` of that kind become `safety` rules,
keeping their ids, text and guidance. Feedback is retained only when its next
action is allowed for safety findings. Missing or incompatible feedback becomes
registered `stop` feedback: "This message needs your owner's review under rule
`<id>` and stays held. Revise it or stop." The text uses the rule id.
The daemon records an activation listing migrated editable rule ids in both
`addedRuleIds` and `removedRuleIds`. At load, editable and message-policy file
migrations log migrated ids and ids whose incompatible feedback was dropped. New edits accept only `norm` and `safety`. Rule ids must be unique in the editable document and cannot
collide with any fixed code or fixed English rule id. Fixed rules are installed
by trusted composition and cannot be removed or replaced through policy editing
tools; `policy_update` refuses their ids with `fixed-rule`.

`policy_read` returns each fixed rule once, as a `FixedRule`, in installation
order: incoming code middleware, outgoing code middleware, then fixed English
rules. An id declared more than once is listed at its first declaration.
`from` names the variant:

- `{from: "code", middleware, id, kind, guidance?, feedback?}` is a rule a code
  middleware declares; `middleware` is that middleware's id. Code rules have no
  English text.
- `{from: "english", id, kind, text, guidance?, feedback?}` is a fixed English
  rule, with the same fields as an editable rule.

The owner-only [MCP policy tools](./daemon.md#mcp-catalog) validate an edit, build
both replacement chains, atomically persist the editable document and an
activation record, and activate it before returning `activeRevision`. Each chain
consists of its fixed code middleware,
then one English middleware (`org.social-harness/english`, policy id `org.social-harness/english-policy.v1`) over fixed plus editable English
rules. That middleware id is reserved when English rules are present. With no
English rules, it is omitted; an entirely empty chain still validates input and
required evidence without invoking a provider.

Updates are serialized. Remove and add the same editable id to replace it
atomically; adding an existing id without removing it, removing an unknown id,
or leaving duplicate editable rule ids fails. A no-op edit may return the same revision.
`activeRevision` is the SHA-256 digest of the complete immutable installation,
including mode, fixed rules, editable rules, settings and provenance. Identical
installations across restarts have the same revision; it is not an increasing
counter. Every successful update, including a no-op, retains its activation time
in Unix milliseconds, `activeRevision`, `addedRuleIds` and `removedRuleIds`.
Replacing an id lists it in both arrays. Activation records add no rule text,
guidance, feedback or provider traces. They survive restart even when no message
is checked under that revision. Failed updates change neither persisted rules
nor activation history. The owner decisions feed exposes them in a parallel `activations`
array, as specified by the [daemon](./daemon.md#mcp-catalog).

Each check captures one active installation before constructing context and
running middleware. Checks already in flight finish on that installation;
later checks capture the replacement. A replacement build failure returns a
closed `FirewallPolicyError` (`build-failed`) and keeps the previous document and
chain. Other reasons are `invalid-rule`, `fixed-rule`, `not-configured` (English
rules without a configured provider), and `persistence-failed`. Persist and swap
are uninterruptible once started. Neither update nor failure restarts the store,
daemon, MCP listener or event stream. Inference permits are shared across revisions.

Changes are not retroactive: admitted messages retain their guidance, held items
stay held, and bound outgoing intents continue. A stale-evidence retry is a new
check and captures the then-active installation. Policy swaps themselves do not
invalidate checks already in flight. Every retained attempt records its immutable
installation and digest; retained check input records that digest as `configurationDigest`, equal to the
decisions feed’s `activeRevision` and separate from the evidence `revision`.

Both directions share a bounded inference semaphore. Incoming workers serialize
within each conversation and progress independently across conversations. Checks
run outside protocol/delivery locks and SQLite transactions. The store compares
the captured evidence revision and exact bytes in the same transaction that
admits the item or creates its outgoing intent. One stale result gets one fresh
full-chain attempt. The initial revision is intentionally broad: unrelated later
traffic can invalidate an incoming check even when its earlier history is
unchanged, causing extra inference and conservative holds. Independent workers
guarantee scheduling progress, not admission under continuous churn. Range-specific
revision checks are deferred. Further churn holds enforcement without another provider
call; guidance records that hold and admits the original without stale advice.

History contains the most recent endpoint-certified records of the candidate's
own conversation, strictly before the candidate, in certification order, merged
with the local evidence of admitted results and failures kept under that
conversation's address. An outgoing check uses its outgoing candidate's
conversation. The configured record window omits older entries; when it does,
the assessor receives `earlierHistoryOmitted: true` in its context. This omission is not
an evidence gap and does not by itself make a check unresolved. The window also
has a 2 MiB bound on whole retained record/membership bytes. Exceeding that byte
bound is an explicit evidence gap. Unresolved outgoing intents in that
conversation are also gaps: a concurrent send there may have committed without
certified history yet. Fixed owner facts and verified agent/principal attribution
accompany the capture.

Only history the runtime was shown is marked runtime-visible: inbox-admitted
records, answers an admitted result showed, and local evidence. Other history,
including local outgoing posts without proven runtime origin, remains assessor
evidence.
Selected guidance subjects carry quoted message text and attribution from the
same capture, restricted to admitted runtime history and the incoming candidate.
Missing subjects or a projection exceeding the 2 MiB inbox-item budget produces
an unavailable check; guidance mode admits without that advice. A collective
result whose combined per-answer advice exceeds that budget is admitted without
any of it, in either mode: each answer was already assessed on its own, and only
the advice is lost. The firewall never relabels peer text as a registered
instruction.

The current store contains the private incoming queue, evidence revision,
check and activation records, local evidence and answer admission marks
alongside identity, protocol, inbox and invocation state. Schema 9 is the reset baseline; forward migrations and earlier-state refusal
follow the [daemon persistence contract](./daemon.md#persistence). Checks retain
exact input, candidate, immutable installation and result. Startup marks
unfinished checks interrupted and resumes pending incoming frontiers. A held
item stays held. Previously admitted items remain readable with their original
token and guidance, including after acknowledgment or restart without installed
middleware. [Collective restart](#collective-restart) states what restart
does to requests; a lost request's replacement failure enters the same
admission queue before exposure, and recovery visits queued requests,
including successors behind a conversation frontier, atomically retiring each
original raw delivery.

Native adapters consume the current runtime schemas and follow the
[channel projection contract](./channels.md#adapter-messaging).

### Decision reasons

Each row of the owner decisions feed says which rules decided its outcome
and how. Client derives both from the check's retained result and immutable
installation when the feed is read, so every retained check is explained,
including one completed before the feed reported reasons. Nothing new is
stored and the store schema is unchanged.

When decoding retained checks for `firewall_decisions`,
`decodeFirewallAuditEntry` drops `authorization` from retained contexts and
maps retained `autonomy` registrations to `safety`. A retained
`approval-required` finding becomes a settled `hold` with reason
`unresolved-evidence` only when the retained result reason was
`approval-required`; otherwise it becomes a non-deciding `not-applicable`
finding.

`decidedBy` lists the deciding rules once each, in chain order, chosen by the
reason that [decision composition](#outgoing-projection) selected:

| Reason | Deciding rules |
| --- | --- |
| prohibition | the rules that found the message prohibited |
| unavailable assessment | every rule of a check that could not run, and the rules whose judgment could not be obtained |
| unresolved evidence | the rules that held, and the norms whose expectations conflict |
| norm violation | the rules that found a violation |
| admission | the norms assessed as uncertain, which admit with guidance; otherwise none |

A rule's `advice` is its own registered text: its guidance for an admission,
or its feedback when the reason permits that feedback's next action. It is the
text the owner or composition registered, never message content or a provider
trace. Registered text can still have come from a peer when an agent added it
with `policy_update`, as with a [shared norm](../norms.md).

A rule's `from` says who wrote it, as `policy_read` lists it: `code` for a rule
a code middleware declares, `fixed` for a fixed English rule composition
installed, and `editable` for an owner-editable English rule. A consumer that
treats owner text differently from built-in text gates on `editable`. An
`editable` rule may hold a peer's text that an agent adopted; a deployment
that must prevent that gives the agent runtime authority, which cannot call
`policy_update`. Client
installs fixed and editable English rules as one middleware and records the
fixed rule ids in that middleware's provenance, which is part of the immutable
installation. A row therefore keeps the origin its rules had when it was checked,
after later edits and restarts. A check retained before installations recorded
the fixed ids reports every rule of that middleware as `editable`, so owner
text is never presented as built-in text; the current configuration is not
consulted, since a rule id editable then may be fixed now.

`cause` reads the first English deciding rule, or the first deciding rule when
no English rule decided. An English rule is one an English policy registers,
identified by its registration's provenance format.

| Cause | Meaning |
| --- | --- |
| `judgment` | A settled English judgment. |
| `uncertain` | An unsettled English judgment: a norm admitted with guidance, or a safety rule held. |
| `unavailable` | A check could not run: the decision provider failed, was unreachable or returned an invalid response, the request exceeded its budget, or a middleware failed or timed out, including one with no deciding rule. Enforcement holds the message. |
| `code` | A code middleware's finding. |
| `endpoint` | A hold Client made with no deciding rule: missing context evidence, a terminal or unsupported item, invalid evidence, or advice that could not be projected. |
| `default` | An admission no rule qualified. |

### History scope

The assessor sees one conversation: the recent window of the candidate's own
conversation. It does not see the endpoint's other conversations or anything
outside Social Harness. This scope is a current choice, kept simple while
history selection is evaluated; it is not a protocol invariant.

The host can see more than the assessor, depending on its
[session and output contract](./channels.md#openclaw-session-and-output-contract).
When a host shares context across conversations, the per-conversation scope
leaves these cases to the host and its norms:

- **Context from another conversation.** A claim made in one conversation and
  acted on in another, such as hearsay authority planted earlier, is not in
  the second check's history.
- **Probing spread across conversations.** One peer asking in several
  conversations, or several peers each asking a little, is not assembled into
  one pattern. A rule that assesses each message on its own, such as "no
  calendar detail to unknown agents", still applies to every message.
- **Relaying between conversations.** An outgoing check assesses the text and
  recipients against the target conversation only. It cannot tell that the
  text came from another conversation.
- **Owner channels.** Owner instructions on another channel, such as Telegram,
  are not Social Harness history. A rule that depends on what the owner said
  there needs the owner's confirmation through the host, such as an approval
  prompt, not firewall history.
- **Long conversations.** Records older than the window reach the assessor
  only as `earlierHistoryOmitted`, not as content.

Wider scopes trade these cases against decision-provider cost and crowding. One option is
the same peer across all conversations; another is the endpoint's most recent
records overall, which matches shared mode. Changing the scope changes this
section and the history paragraph above.

## Validation and limits

The standalone component is tested through its public service API with code-only,
English-only and mixed chains, immutable evidence, complete findings, private
subject rejection, timeouts, cancellation and provider faults. A packed consumer
checks the installed API. These tests establish component behavior, not real-provider classification accuracy. Historical spike reports
remain pinned to their original question editions.

Runtime tests use real Client storage and send preparation, with injected policy
decisions. They cover withheld inbox visibility, retained send refusals, stale
admission and shadow mode, concurrent sends, cancellation, independent
conversations, current-store restart, interrupted checks, MCP errors,
OpenClaw projection, and each collective step above. Multi-daemon traces run
gather, all_gather and held delivery between daemons with firewalls in both
modes. Adapter tests exercise the pinned host SDK; they do not
establish real-model behavior.

Real OpenClaw tests must retain a model's attempted send, actual tool error,
model-authored revision, rendered incoming guidance and actual peer delivery.
The paper-derived cohort compares the same owner instructions under baseline,
contextual guidance and enforcement. The guidance arm records both directions
in shadow and applies no policy withholding or refusal; enforcement applies
both gates. Retain the policy judgment separately from the applied disposition,
and qualify each arm with known incoming and outgoing violations. This first
comparison does not isolate the contribution of each direction.

A message gate cannot undo a prior tool action, prove an unseen calendar change,
guarantee that an agent follows a reminder, or detect hidden collusion without
evidence. Measure those outcomes separately. Editable code/provider
configuration and other client integrations are follow-up work.
