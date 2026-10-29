---
name: docs
description: |
  Write, review, and maintain Social Harness documentation. Covers reader
  purpose, composition, prose, site conventions, and generated API reference.
  Load before editing documentation or flow diagrams.
---

# Documentation

Write documentation that helps readers learn, complete tasks, find precise
answers, or understand the system. This guide records the owner's writing
preferences and the repository's publishing conventions. Refine it as we
review documents together. `AGENTS.md` defines documentation authority.

## Choose the reader's purpose

[Diátaxis](https://diataxis.fr/compass/) distinguishes two dimensions: learning
or working, and action or knowledge. Choose the reader's need before choosing
the document's structure.

| Reader needs | While learning | While working |
| --- | --- | --- |
| Practical action | Tutorial: learn through a guided exercise | How-to guide: accomplish a real task |
| Knowledge | Explanation: understand concepts and relationships | Reference: find precise facts |

- A [tutorial](https://diataxis.fr/tutorials/) guides a learner through a
  concrete exercise. Choose a reliable path, show useful results along the
  way, and introduce concepts as the learner encounters them. Defer optional
  alternatives so the learner can follow without prior expertise.
- A [how-to guide](https://diataxis.fr/how-to-guides/) helps someone who knows
  their goal complete a task in their own environment. State prerequisites,
  necessary choices, steps, and verification. Include branches when the task
  requires judgment, and link to background explanations.
- [Reference](https://diataxis.fr/reference/) supports lookup during work.
  Organize facts by the contract or interface they describe. Use consistent
  names and structures so readers can find exact behavior, bounds, defaults,
  and failures without reading the page from the beginning.
- [Explanation](https://diataxis.fr/explanation/) develops understanding of a
  bounded subject. Connect concepts, assumptions, constraints, and
  consequences. Explain why a property matters or a design works. Link to
  decision evidence where it helps, while keeping investigation history in
  its owning record.

Use these forms where readers need them. A README helps readers choose a
path and may link to all four. A short definition or example can orient a
reference reader. Move a sustained lesson or discussion to its own page when
it interrupts that purpose. Create pages for actual needs rather than four
pages for every feature.

## Choose the source of truth

Reader purpose and source ownership are separate choices. A manually maintained
wire specification and a generated API reference both serve reference needs.
An explanation can discuss either one's concepts. Generation does not supply
the tutorials, how-to guides, or explanations readers also need.

Maintain specifications by hand. They define the concepts, responsibilities,
guarantees, and observable behavior an implementation must satisfy. State
assumptions and failure conditions where they limit a guarantee. Choose
precision to suit the contract: a signed wire format needs exact bytes and
validation rules, while an evolving architecture may establish responsibilities
before selecting mechanisms. Record unresolved choices explicitly. Reading
the code can reveal a discrepancy, but does not authorize rewriting the
specification to match it.

Generate API reference from the declarations and schemas that own the API.
Derive types, validators, and language bindings from those definitions wherever
they would otherwise repeat the same contract. TypeDoc generates documentation
from TypeScript and JSDoc. Polish that source prose with the same care as a
hand-written page. Explain what callers need beyond the signature, such as
preconditions, ownership, lifetime, effects, and failures. Link to the owning
specification for protocol guarantees. Keep export inventories and copied
signatures out of hand-written specs. Verify that a generated page exists
before removing its only useful explanation elsewhere.

Document implementation only when the explanation adds something a reader
cannot obtain from clear code. Implementation comments explain what the code
leaves unclear, such as a non-obvious invariant, in present tense.
Bugfix rationale, investigation outcomes, failed approaches, and change
history belong in issues, PR descriptions, and commit messages. Durable
architecture decisions belong in ADRs. Remove file tours,
dependency inventories, and narration of control flow during simplification.

Useful examples have different scopes:

- [MCP's protocol specification](https://modelcontextprotocol.io/specification/2025-11-25/basic)
  defines interoperability rules separately from its SDK reference.
- [ACP's protocol overview](https://agentclientprotocol.com/protocol/v1/overview)
  explains participants and message flow. Its
  [TypeDoc reference](https://agentclientprotocol.github.io/typescript-sdk/)
  documents the TypeScript library.
- [Exoharness's specification](https://github.com/exoharness/exo/blob/main/exoharness/docs/spec.md)
  develops concepts and responsibilities at an architectural level.
- [OpenClaw's schema workflow](https://docs.openclaw.ai/concepts/typebox)
  derives validation, schemas, and native models from typed definitions.

## Compose for the reader

Begin each document with a topic sentence that establishes its subject or
practical outcome. Develop it at the level and in the order the reader's
purpose requires. Introduce a card before its fields,
authentication before its signature profile, and a task before its commands.
The [MCP introduction](https://modelcontextprotocol.io/docs/getting-started/intro)
provides an example of moving from a definition to concrete uses and reader
paths.

Keep each page at its chosen level of abstraction and link to the detail a
reader needs next.

Develop one topic per paragraph. Let its opening sentence establish that
topic and let the following sentences explain or support it. Keep related
words close together and use parallel forms for parallel ideas. These
composition principles come from
[The Elements of Style](https://www.gutenberg.org/files/37134/37134-h/37134-h.htm).
Use the installed `google-documentation-guide` for the broader documentation
guidance.

## Revise the prose

- Name the actor and use an active verb: “Registry rejects expired requests.”
  Address readers as “you” when giving instructions.
- State the behavior directly. Remove catalogues of rejected designs and
  rhetorical contrasts such as “not X, not Y, but Z.” Retain a precise
  exclusion when it defines a security boundary or rejected input.
- Remove stock transitions, self-praise, inflated claims, vague qualifiers,
  and repeated assurances. State uncertainty only when the evidence leaves
  something unresolved, and identify what remains unknown.
- Prefer complete, connected sentences. Rewrite prose that relies on em
  dashes, semicolons, parenthetical asides, or fragments to join its thoughts.
  Concision means keeping useful meaning, not making every sentence short.
- Introduce precision when the reader needs it. Field names, byte limits,
  library names, and signature profiles do not belong ahead of their purpose.
  Preserve exact commands, identifiers, and protocol requirements where they
  govern an action or result.
- Define an unfamiliar term before relying on it, then use one name for it.
  Use “Social Harness” for the project and each package or executable's exact
  name for that artifact. Bold only UI labels and keyboard keys.

## Review each document and the set

Read the complete draft after editing it. Check that the opening establishes
its purpose, each section serves that purpose, and each paragraph adds
something the intended reader needs. Watch for changes of purpose within a
page, such as a setup procedure turning into a catalogue of every setting.
Rewrite awkward passages in place. Adding a simpler introduction above the
same explanation creates another copy.

Read the affected documents together. Give each fact an owning page and link
to it where the reader needs it. Remove repeated summaries, callouts, and
closing link lists. A link should help a reader continue a task or find a
necessary explanation. There is no required link count or closing section.

For each affected folder, follow the paths readers use to learn, complete
tasks, look up facts, and understand concepts. Review the applicable guides,
explanations, specifications, generated reference, and source comments
together. Keep protocol guarantees in the spec and API contract details in the
owning JSDoc. Retain practical instructions and examples in the guide that uses
them. Delete explanations that merely repeat the implementation. Regenerate the
reference after source edits and read the result.

Review correctness separately. Preserve unique guarantees and relevant
failure conditions while removing repetition. Check implementation claims
against source and public contracts. Use the Social Harness paper to resolve
questions of intent, and bring unresolved design choices to the owner.

Before a docs PR merges, give a reader without source or session context a
task suited to the document. Have a learner complete a tutorial, a practitioner
apply a how-to guide, a reference reader find an exact answer, or an explanation
reader reason through an example. Use
[doc-coauthoring's reader test](https://github.com/anthropics/skills/blob/main/skills/doc-coauthoring/SKILL.md#stage-3-reader-testing)
to find where the draft makes them guess. Have them follow the changed paths,
including their commands and links. Fix blockers or record them as issues
linked from the PR. State who reviewed the draft, what they actually tried,
and what remains unverified. Use context the owner already supplied.

## Examples from our reviews

- The identity spec opened with a source location, a milestone label, and
  version notation. Delete the metadata. Explain notation beside its example
  and compatibility in its owning section.
- “Standards substrate” listed libraries and rejected formats before
  explaining identity. Remove it. Keep each standard with the encoding rule
  it determines.
- A Registry source README described `http.ts` as HTTP handling and
  `storage.ts` as persistence. Delete the inventory. The reason a failed
  registration still consumes its replay nonce belongs with that guarantee.
- The Registry README summarized a linked guide's setup, health checks, and
  storage caveat. Keep the task link and let the guide carry the procedure.
- TypeDoc showed signing inputs as unlinked type names. Its native
  [`@inline` tag](https://typedoc.org/documents/Tags._inline.html) now renders
  their fields from the source types. Keep caller constraints in JSDoc and
  let the generator produce the field lists.

- Daemon setup and first messages serve different needs. Keep installation,
  registration, recovery, and diagnostics in the how-to. Put the guided
  send-and-read exercise in a tutorial that links to that setup.

## Site pages

Site pages have `title`, a one-sentence `description`, and `read_when` with
two to four reader situations. A guide's description names its outcome.
Mintlify renders the title as H1, so body headings start at H2.

```yaml
---
title: Connect an agent
description: Connect your agent to a network and send its first message.
read_when:
  - You have an agent and want it on a network
  - Your agent connects but its messages do not arrive
---
```

Put prerequisites before dependent actions and number steps by dependency.
Keep commands with their expected results and likely failures. State a
quickstart's expected time cost and observable result, such as a delivered
message. Troubleshooting starts with the symptom or exact error, then explains
the diagnostic, result, remedy, and verification.

Use optional detail only where a reader benefits from it. Accordions can
hold advanced material. Reserve warnings for data loss or security. Include
notes and follow-up links only when they add useful context.

Hand-written `.mdx` pages use root-relative site links for content the site
hosts. The `docs/reference/spec/*.md` pages also serve GitHub readers and can use relative
file links. Choose the folder from the
[documentation map](../../../docs/README.md), and use the same reader purposes
in site navigation. When a page moves, update repository links and code
diagnostic URLs to its new home.

## Examples and references

Use the smallest complete example of a plausible task. State the working
directory, prerequisites, and replacements before the command. Keep names,
ports, and paths consistent. Use safe identities and obvious secret
placeholders. Prefer a supported CLI to hand-edited configuration.

Put one command in each fenced block with a language tag and no shell prompt.
Use `<angle-bracketed>` placeholders. Label partial configuration, pseudocode,
and representative output. Say what success looks like and show output when
the reader needs to compare it. Verify examples against the implementation.

Configuration references give exact names, accepted values, requiredness,
defaults, and purpose. Explain units, bounds, precedence, activation, and
interactions where they affect use. Document exit status and output streams
when scripts depend on them. Put platform and installation limits beside
the affected instructions.

Cite code by symbol name, such as `file.ts → handleFrame`. Use line numbers
only in PRs, issues, and reviews, which describe a fixed revision.

## Source ownership and checks

Build the API reference with `pnpm docs:api`. TypeDoc writes `dist/api`.
Shared site values live in `docs/docs.json` variables, and reusable content
lives in `docs/snippets/`. Check site links with `pnpm -s docs:check`.

Add a diagram when it makes a relationship or invariant easier to understand.
Keep it with the explanation that owns that fact. API diagrams belong in the
owning symbol's JSDoc. `pnpm docs:check:mermaid` checks the Mermaid dialect
GitHub accepts. TypeDoc displays these diagrams as code blocks.
