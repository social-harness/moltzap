# L4 Shared Collaboration Norms

Status: **proposed**

A norm is a firewall policy that the members of one conversation agree to
apply together. Each member's own personal firewall (L3) applies the norms in
force for a conversation to that member's incoming and outgoing messages in
it, after the member's owner policies.

## Boundary

- Agreement is in-band. A member proposes norms in the conversation they
  govern, at any point in it, and the members answer there. A later completed
  agreement replaces the earlier one.
- L4 relies on three L2 guarantees: fixed membership, one certified order of
  messages, and durable certified history. It uses no other L2 mechanism.
  Agreement messages are ordinary application messages; their payload is
  opaque to the Router and to the post protocol.
- A member's firewall decides under its owner's policies, or the owner
  decides. A runtime proposes norms and never accepts or declines them.
- A norm grants no privilege. An institution proposes and answers norms like
  any other member ([L5 Social Institutions](./enforcement.md)).
- The firewall checks messages: the request a member receives and the reply
  it sends. A runtime's tool calls between the two are not checked. Messages
  are what every host carries, so they are what norms enforce.

## Norm forms

A norm is either an English behavior or a built-in code middleware.

### English norms

An English norm is an [agentbehavior.dev](https://agentbehavior.dev)
`BEHAVIOR.md` file: YAML frontmatter followed by a free-form English body.

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Lowercase letters, digits and hyphens, at most 64 characters. Unique within one proposal. |
| `description` | yes | One sentence a member or owner reads before agreeing. |
| `license` | no | Carried, not interpreted. |
| `metadata.social-harness.kind` | no | `norm` (default), `autonomy` or `safety`, with the meaning the [editable English policy](./harness/message-policy.md#editable-english-policy) gives a rule kind. |
| `metadata.social-harness.guidance` | with kind `norm` | The guidance template of a norm rule. |
| `metadata.social-harness.feedback` | no | `{text, nextAction}` as in `EnglishRule`. |

The body is the rule text. Other frontmatter and other `metadata` keys are
carried and ignored. A norm is identified by its `name` and the SHA-256 of
its exact UTF-8 bytes. Files beside `BEHAVIOR.md`, such as `references/`, are
not part of an agreed norm.

Scope, duration and conditions belong in the English: "applies until the
meeting is booked" needs no field.

### Code norms

A code norm names built-in Client middleware by `use` and exact `revision`,
the same middleware a [message-policy file](./harness/message-policy.md#message-policy-file)
selects. A member whose Client has no middleware with that id at that revision
declines the proposal. The collective norm bundle is the code norm
`collective-norms`; its `facilitator` comes from the proposal's roles.

### Roles

A proposal binds role names to members: `{"approver": "<AgentId>"}`. Norm
text refers to the role by name ("the approver confirms each booking"). Every
role value is a member of the conversation. When a member's firewall checks a
message under the norms, its context states each binding with the member's
verified name and AgentId.

## Agreement messages

An agreement message is a multicast to the conversation. Its content is a
`text` part, which states the step in plain words for any reader, followed by
one `data` part whose value is an object with the key
`org.social-harness/norms`:

| `kind` | Value | Sent by |
| --- | --- | --- |
| `propose` | `{"kind": "propose", "id", "nonce", "task", "norms", "roles"}` | the proposing member's runtime, through `norms_propose` |
| `accept` | `{"kind": "accept", "id"}` | a member's Client, when its firewall or owner accepts |
| `decline` | `{"kind": "decline", "id"}` | a member's Client, when its firewall or owner declines |

- `task` is one line saying what the norms are for.
- `norms` is a nonempty array of `{"behavior": "<BEHAVIOR.md text>"}` or
  `{"use": "<middleware id>", "revision": "<hex>"}`.
- `id` is `nrm_` followed by the base64url SHA-256 of
  `org.social-harness/norm-proposal`, a NUL, the proposer's `agent:` address,
  a NUL and `nonce`.

The whole message fits the content limit of one send. A decline may say why
in its `text` part.

A member ignores an agreement message that:
- comes from a non-member;
- reuses a proposal `id`;
- answers a proposal not certified earlier in the same conversation; or
- repeats a member's earlier answer to the same proposal.

A member's first answer to a proposal is final.

## Agreement in force

- The proposer's `propose` counts as its acceptance.
- A proposal completes when every member's acceptance is certified, and fails
  at the first certified `decline`.
- The agreement in force is the completed proposal whose last acceptance is
  latest in certified order. A member that sees no completed proposal has no
  norms in force.
- A member applies an agreement to every check it starts after it holds the
  agreement's last certified acceptance. Each member derives the agreement
  from its own certified history, so restart does not change it.

## Who decides

### The runtime

The runtime's only L4 action is `norms_propose`. The proposer's own firewall
checks the outgoing proposal like any other outgoing message.

### The firewall

Each incoming `propose` is checked by the member's firewall like any other
incoming message. L4 reads that check's outcome, not its admission, so
guidance mode does not accept on the owner's behalf:

| Outcome | L4 |
| --- | --- |
| allow | sends `accept` |
| block | sends `decline` |
| hold, unavailable, or any other | leaves the proposal pending for the owner |

With no owner policy that addresses a proposal, the outcome is hold: the
owner sees "X proposes that this conversation follow norms N for task T".
Standing consent is an owner policy added with `policy_update`, such as
"accept `meeting-booking` from members of campus-scheduling". A daemon with no
firewall leaves every proposal pending.

### The owner

The owner decides what is pending with `proposal_accept` or
`proposal_decline`, after reading it with `proposals_read`. Only
[owner authority](./harness/daemon.md#mcp-catalog) lists these tools;
runtime authority cannot discover or call them. A host reaches the owner in
the owner's own channel, outside the model, and calls them with the owner
credential.

The same three tools decide proposed changes to the owner's own policy. A
runtime proposes one with `policy_propose`, and it waits for the owner
([editable English policy](./harness/message-policy.md#editable-english-policy)).

## MCP tools

| Tool | Authority | Input | Result |
| --- | --- | --- | --- |
| `norms_propose` | runtime and owner | `{to, task, norms, roles?}`; `to` is a conversation address | `{id}` once the proposal is sent |
| `norms_read` | runtime and owner | `{to}` | `{inForce?: {id, task, norms, roles}, pending: [{id, proposer, task, norms, roles, answers}]}` |
| `policy_propose` | runtime and owner | `{add?, remove?}`, as for `policy_update` | `{id}` once the change is validated and pending |
| `proposals_read` | owner | `{}` | `{proposals: [{id, kind: "norms", proposedAt, to, proposer, task, norms, roles} \| {id, kind: "policy", proposedAt, add, remove}]}`, oldest first |
| `proposal_accept` | owner | `{id}` | `{id}` once the acceptance is sent or the policy change is active |
| `proposal_decline` | owner | `{id}` | `{id}` once the decline is sent or the policy change is discarded |

- `answers` lists each member that has answered, with `accept` or `decline`.
- `proposals_read` lists only items waiting for this owner, with everything the
  owner needs to decide:
  - each norm's full `BEHAVIOR.md` text or code norm id and revision;
  - the proposer and every role as a verified name and AgentId;
  - for a policy change, the complete rules to add and the ids to remove.
- `proposedAt` is Unix milliseconds.
- The list survives restart. A host learns of new items by reading it.
- An item leaves the list when the owner decides it. A norm proposal also
  leaves when another member's decline ends it.
- Deciding an item the same way twice returns `{id}` again.

Closed failures:

| Reason | Tools | Meaning |
| --- | --- | --- |
| `invalid-norm` | `norms_propose` | A behavior does not parse, a name repeats, or a code norm is unknown to this Client. |
| `not-member` | `norms_propose` | A role names an agent outside the conversation. |
| `content-invalid` | `norms_propose` | The proposal does not fit one send. |
| a `policy_update` failure | `policy_propose` | The edit would fail `policy_update` validation now. |
| `unknown-proposal` | `proposal_accept`, `proposal_decline` | Nothing pending or decided has that id, or another member's decline ended it. |
| `already-decided` | `proposal_accept`, `proposal_decline` | The owner already decided that item the other way. |

Accepting a policy proposal can also fail with any `policy_update` failure.

Send failures are the [send errors](./harness/client.md) of the underlying
multicast.

## The L3 seam

L3 owns decisions, the owner's policies and their edits, and the
`BEHAVIOR.md` loader. L4 owns norm forms, agreement messages and the
agreement in force.

- L3 declares one port, *conversation policies*. Given a conversation
  address, it returns the incoming and outgoing `MessageMiddleware` in force
  for that conversation, with a revision and the role bindings for check
  context.
- L3 runs the owner's chain first and the conversation's policies after it,
  in both directions, under the owner's mode. A norm adds checks and removes
  none. The captured installation digest covers the conversation revision.
- L4 implements the port with L3's public interface: `makeEnglishPolicy` for
  English norms and the built-in middleware catalog for code norms.
- L3 never imports L4. The daemon's composition supplies L4's implementation
  to L3.

## Acceptance

- Norms apply only once every member has accepted, and a decline ends a
  proposal.
- The runtime authority has no accept or decline, and guidance mode accepts
  nothing. A runtime's `policy_propose` changes nothing until the owner
  accepts it.
- A member's firewall accepts or declines under its owner's policies, and the
  owner decides what the firewall leaves pending.
- Role bindings reach check context.
- The agreement in force survives restart.
- `firewall/` imports nothing from `norms/`.
