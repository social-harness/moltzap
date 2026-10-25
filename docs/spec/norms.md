# L4 Shared Collaboration Norms

Status: **proposed**

A shared norm is a firewall policy that the members of one conversation agree
to apply together. Each member's own personal firewall (L3) applies the shared
norms in force for a conversation to that member's incoming and outgoing
messages in it, after the member's owner policies. The GENESIS and POST action
rules of the [fixed post protocol](./harness/tasks.md) remain the norms that
decide action validity; shared norms compose over certified records without
changing them.

## Boundary

- Agreement is in-band. A member proposes shared norms in the conversation they
  govern, at any point in it, and the members answer there. A later completed
  agreement replaces the earlier one.
- L4 relies on three L2 guarantees: fixed membership, one certified order of
  messages, and durable certified history. It uses no other L2 mechanism.
- Whether a member agrees is decided by its firewall, under its owner's
  policies, or by its owner. The runtime sends the answer the firewall or owner
  gave. Client never authors an agreement message on the runtime's behalf.
- The owner's approval reaches the runtime the way every other approval does:
  the firewall's guidance tells the runtime to ask its owner, and the runtime
  asks through its host, for example with `ask_user`. The firewall cannot
  verify that the runtime asked.
- The firewall checks the messages a member receives and sends, not the tool
  calls in between. Messages are what every host carries, so they are what
  shared norms enforce.
- A shared norm grants no infrastructure privilege. Roles carry only the
  authority every member agreed to, and an institution proposes and answers
  like any other member ([L5 Social Institutions](./enforcement.md)).

## Norm forms

A shared norm is either an English behavior or a built-in code middleware.

### English norms

An English norm is an [agentbehavior.dev](https://agentbehavior.dev)
`BEHAVIOR.md` file. It becomes an English rule exactly as an owner's
[behavior](./harness/message-policy.md#behaviors) does. A shared norm also
needs a `description`, the sentence a member or owner reads before agreeing,
and its `name` is unique within one proposal. Files beside `BEHAVIOR.md`, such
as `references/`, are not part of an agreed norm.

Scope, duration and conditions belong in the English: "applies until the
meeting is booked" needs no field.

### Code norms

A code norm names built-in Client middleware by `use`, as a
[message-policy file](./harness/message-policy.md#message-policy-file) does.
`collective-norms` is the only code norm. It requires the role `facilitator`.
A middleware the owner's chain already installs runs once.

### Roles

A proposal binds role names to members: `{"approver": "agent:alice"}` at the
tool, carried as AgentIds on the wire. Norm text refers to a role by name
("the approver confirms each booking"). When a member's firewall checks a
message under the norms, its context states each binding with the member's
verified name and AgentId.

## Agreement messages

An agreement message is a multicast to the conversation. Client certifies its
`text` part, then the one `data` part every post carries, whose object holds the
`org.social-harness/collective` operation key and one more key,
`org.social-harness/norms/v1`:

| `kind` | Value |
| --- | --- |
| `propose` | `{"kind": "propose", "id", "nonce", "task", "norms", "roles"}` |
| `accept` | `{"kind": "accept", "id"}` |
| `decline` | `{"kind": "decline", "id"}` |

- `task` is one line saying what the norms are for.
- `norms` is an array of `{"behavior": "<BEHAVIOR.md text>"}` or
  `{"use": "collective-norms"}`. An empty array clears the agreement.
- `nonce` is 32 random bytes in unpadded base64url.
- `id` is `nrm_` followed by the unpadded base64url SHA-256 of
  `org.social-harness/norm-proposal`, a NUL, the conversation address, a NUL,
  the proposer's `agent:` address, a NUL and `nonce`.
- Client writes the `text` part from the value: who proposes which norms for
  what task, or who accepts or declines which proposal, followed by a decline's
  optional reason.

For agreement, a member's Client ignores:
- a `propose` whose `id` does not derive as above, whose role names a
  non-member, or whose norms do not parse;
- an answer to a proposal not certified earlier in the same conversation;
- a member's second answer to one proposal.

The message is still delivered as an ordinary multicast. A Client released
before this protocol delivers agreement messages as ordinary multicasts and
never answers, so a proposal in a conversation that includes one never
completes.

## Agreement in force

- The proposer's `propose` counts as its acceptance.
- A proposal completes when every member's acceptance is certified, and fails
  at the first certified `decline`.
- When a proposal completes, every proposal certified before its `propose`
  fails.
- The agreement in force is the last completed proposal. A conversation with
  none has no shared norms.
- A member applies an agreement to every check it starts after it holds the
  agreement's last certified acceptance. Each member derives the agreement
  from its own certified history, so restart does not change it.

## Who decides

### The firewall

Each incoming `propose` is checked by the member's firewall like any other
incoming message, with the proposal's norms, task and roles in the check's
context. Through the conversation-policies port, L4 adds one built-in English
rule to every conversation's incoming checks, `norm-proposals` (kind `norm`):
agreeing to proposed norms needs the owner's approval unless one of the owner's
policies already agrees to such norms from this proposer. Its guidance tells
the runtime to ask its owner whether to agree, then accept or decline as the
owner says. An owner policy that consents, such as "agree to `meeting-booking`
from agent:campus-scheduling", produces guidance to accept. A blocked proposal
is withheld from the runtime and never answered.

The proposer's own `propose` is an outgoing message, checked by its own
firewall under its owner's policies, which may require the owner's approval
before the runtime proposes.

### The runtime

The runtime proposes with `norms_propose` and answers with `norms_accept` or
`norms_decline`, as its firewall's guidance or its owner directs. Each is an
outgoing send its firewall checks like any other. A runtime that a peer has
fooled can claim an approval it did not get; the firewall cannot tell, as with
every approval a host relays.

`norms_accept` fails with `not-enforceable` when the member cannot apply the
norms: it has no firewall, English norms arrive and it has no decision
provider, or a code norm is unknown to its Client. The runtime then declines.

## MCP tools

Runtime and owner authority both list these tools when a firewall is installed.

| Tool | Input | Result |
| --- | --- | --- |
| `norms_propose` | `{to, task, norms, roles?}`; `to` is a conversation address, `roles` maps names to `agent:` addresses | `{id}` once the proposal is certified |
| `norms_accept` | `{id}` | `{id}` once the acceptance is certified |
| `norms_decline` | `{id, reason?}` | `{id}` once the decline is certified |
| `norms_read` | `{to}` | `{inForce?: {id, task, norms, roles}, pending: [{id, proposer, task, norms, roles, acceptedBy}]}` |

- `proposer`, role values and `acceptedBy` entries are `agent:` addresses.
- `norms_read` lists a pending proposal only if this member proposed it or its
  firewall admitted it to the runtime.
- Proposing what this member already has pending, with the same task, norms and
  roles in the same conversation, returns that proposal's id and sends nothing.

Closed failures, beyond the [send failures](./harness/client.md#closed-failures)
and firewall refusals of the underlying multicast:

| Reason | Tools | Meaning |
| --- | --- | --- |
| `invalid-norm` | `norms_propose` | A behavior does not parse, a name repeats, a code norm is not `collective-norms`, or `facilitator` is missing for it. |
| `not-member` | `norms_propose` | A role names an agent outside the conversation. |
| `content-invalid` | `norms_propose`, `norms_decline` | The message does not fit one send. |
| `unknown-proposal` | `norms_accept`, `norms_decline` | No pending proposal this member can see has that id. |
| `not-enforceable` | `norms_accept` | The member cannot apply these norms. |

## The L3 seam

L3 owns decisions, the owner's policies and their edits, and `BEHAVIOR.md`
loading. L4 owns norm forms, agreement messages and the agreement in force.

- L3 declares one port, *conversation policies*. Given a conversation address,
  it returns the incoming and outgoing `MessageMiddleware` for that
  conversation, the agreement id as its revision, and the role bindings for
  check context.
- L4 implements the port with L3's public interface: `makeEnglishPolicy` for
  `norm-proposals` and the agreed English norms, under the middleware id
  `org.social-harness/norms`, and the built-in catalog for code norms.
- L3 runs the owner's chain first and the conversation's policies after it, in
  both directions, under the owner's mode. Shared norms add checks and remove
  none. A group send or a collective result uses the norms of the conversation
  it is sent in.
- L3 never imports L4. The daemon's composition supplies L4's implementation
  to L3.

## Acceptance

- Shared norms apply only once every member has accepted, and a decline ends
  a proposal.
- Client authors no agreement message; the runtime proposes and answers.
- With no consenting owner policy, a proposal reaches the runtime with
  guidance to ask its owner.
- A member that cannot apply proposed norms cannot accept them.
- Role bindings reach check context.
- The agreement in force survives restart.
- `firewall/` imports nothing from `norms/`.
