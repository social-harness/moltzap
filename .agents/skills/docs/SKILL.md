---
name: docs
description: |
  Documentation style and regeneration in this repo — where flow
  diagrams live, the Mermaid dialect GitHub actually accepts, and when to
  use TypeDoc and Mintlify. Load for any docs page edit, adding a
  flow diagram, or touching anything under docs/.
---

# Documentation

Authority order lives in `AGENTS.md → Docs` and governs how to *read* anything.
This is how to *write* it.

## API reference and shared values

Build the API reference with `pnpm docs:api`. Native TypeDoc output lives in
`dist/api`; never hand-edit it.

Mintlify variables in `docs/docs.json` and reusable snippets under
`docs/snippets/` own shared site content. Check site links with
`pnpm -s docs:check`.

## Flow diagrams

Flow diagrams are Mermaid in JSDoc above the owning symbol.
`pnpm docs:check:mermaid` checks them; TypeDoc displays them as code blocks.

Change a flow → update its diagram in the same PR.

Cross-package flows are documented **once**, at the canonical owner. Elsewhere,
link by symbol name rather than restating the diagram — a second copy is a
second thing to forget.

## Mermaid, GitHub-strict

`pnpm docs:check:mermaid` enforces this, so treat the list as an explanation of
failures rather than something to memorize:

- `<br>`, never `<br/>`
- literal `<` and `>`, not HTML entities
- no `;` inside `Note` text — it terminates the note
- no `<br>` or parentheses in participant aliases
- `<br>`, not `\n`, in `stateDiagram`
- no bare `<word>` literals

These are GitHub's renderer, not Mermaid's spec: a diagram that previews
correctly in an editor can still fail on GitHub.

## Cold-read check

Before a docs PR merges, a reader with no context follows each changed path
literally: every command as written, every link as clicked. Fix each blocker
they hit in the PR, or file it as an issue linked from the PR. The PR's Checks
section records who did the cold read and what they hit.

## Citations

Cite by symbol name (`file.ts → handleFrame`), never by line. `file.ts:NNN` is
for PRs and reviews, which are snapshots; a line number in a long-lived
document rots at the next refactor.

## Style (adapted from OpenClaw)

Adapted from observed documentation patterns at [docs.openclaw.ai](https://docs.openclaw.ai/).

`AGENTS.md`, the installed `google-documentation-guide` skill, and this
skill's source ownership rules take precedence over these patterns.

### Frontmatter

Each page has `title`, a one-sentence `description`, and `read_when`: 2–4
bullets, each a reader situation. A how-to's `description` names the outcome;
a concept, reference or hub page's names what the page covers.

```yaml
---
title: Connect an agent
description: Connect your agent to a network and send its first message.
read_when:
  - You have an agent and want it on a network
  - Your agent connects but its messages do not arrive
---
```

### Page types

Each page is exactly one type. Guides and quickstarts are how-tos.

| Type | Opens with |
| --- | --- |
| How-to | What the reader will have at the end |
| Troubleshooting | The observable symptom or exact error text |
| Concept | A one-sentence definition |
| Reference | What the command or interface does, then a table |
| Hub | A `Page \| Read it when` table, and little else |

- Guides complete one named task; quickstarts take the shortest supported path.
- Concepts explain entities, ownership, behavior and constraints, linking
  the exact contracts. References support lookup by command, flag or field.
- After the symptom, troubleshooting gives a diagnostic, the healthy result,
  what a failure means, the remedy and how to verify it.

### Page structure

- Mintlify renders frontmatter `title:` as the page H1. Do not repeat it as
  a body H1, even where existing pages do. Start at H2; give a one-line lede.
- Put prerequisites before dependent actions; distinguish user tools,
  credentials, services and prior setup from contributor requirements.
- Number procedure steps by dependency, starting each with an action.
  Keep its command, explanation, success condition and likely failures together.
- A how-to runs: What you need → `<Steps>` → Verify → If this does not
  work → Next steps → Related. Prerequisites never come after the first
  command.
- A how-to ends with `## Next steps`, then `## Related`. Next steps links
  useful follow-up tasks, concepts or references. Concepts and references need
  no artificial procedure or empty prerequisites section.
- Every hand-written `.mdx` page ends with `## Related`: 3–6 root-relative
  links. These pages link to site pages, never to GitHub blob or tree URLs for
  content the site has. The `docs/spec/*.md` pages,
  which readers also open on GitHub, are exempt from both rules.
- Each step that runs a command says what success looks like: "You should see
  `<literal>`." Paste output only when the reader compares it line by line.
- The quickstart states its time cost in its first paragraph, offers a
  one-command path first, and ends at an observable success: a delivered
  message, not a passing build.
- `<Accordion title="Advanced: …">` holds optional detail. `<Warning>` is only
  for data loss or security. `<Note>` is for cross-links.
- When a page splits, its old anchors keep working: keep each moved heading
  on the original page with a link to its new home. A moved page path gets a
  `docs.json` redirect.
- The target `docs.json` layout is tabs that follow the reader's journey:
  Get started → Guides → Concepts → Reference (specs, API) → Help. A PR
  that changes navigation moves toward it; one that leaves navigation alone
  is not held to it.

### Voice and terminology

- Address the reader as "you"; use imperative actions and present-tense
  behavior with a named acting component. Use plain declarative explanations.
- Put one idea in each sentence. Bold only UI labels and keyboard keys.
- "Social Harness" is the project and its display name; `@moltzap/*` are its
  npm package names; `sharness*` are its binary, environment, channel and wire
  names. The introduction page says so once; other
  pages use each name for its own thing and never mix them.
- Define unfamiliar terms on first use and keep one name per concept.
  Preserve exact product names, UI labels, commands, flags, field paths and
  environment variables; distinguish package names from display names.

### Commands and examples

- Use the smallest complete example for a plausible task, with consistent
  names, addresses, ports and paths. State directory, required state and
  replacements first; use safe identities and secret placeholders.
- Put one command in each fence, with a language tag and no `$` prompt.
  Write placeholders as `<angle-bracketed>` and obviously fake. Give the CLI
  path before hand-edited config.
- Make commands copy-pasteable after replacements. Label partial config,
  pseudocode and representative output; show each command's observable result.
  Verify examples against the implementation and public contracts.

### Troubleshooting entries

The heading is the exact error text or symptom. The body gives the cause and
the fix, or links to them.

### Configuration and CLI reference tables

- Tabulate exact setting paths or argument/option names, types or accepted
  values, requiredness, defaults or omitted behavior, and purpose.
- Give command invocations; explain units, bounds, precedence, validation,
  activation, interactions and failure behavior. Include exit status and
  stdout/stderr where scripts depend on them; separate examples from defaults.
- Link shared conventions and owning specifications. Document actual surfaces,
  with version, platform and installation limits beside affected instructions.

### Avoid

- Avoid architecture tours before first use, exhaustive ledes and duplicate links.
- Keep facts at one canonical owner and preserve incoming links and anchors.
  Keep history in release or migration records. Do not import OpenClaw-specific
  interfaces, release policy or prose verbatim.
