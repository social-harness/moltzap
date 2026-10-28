# Collectives

This directory owns gather, all_gather and their answers inside the daemon:
the values carried in a post's collective part, answer validation, and the
state an operation keeps between its request posts and its result.

The service enters through `index.ts`, which exports
`operation.ts → makeCollectiveOperations`: it turns each send into posts and
each certified post into an item or nothing. It also exports
`CollectiveEmitError`, the failure the service's emit port returns when it
cannot keep an item the layer emits, and `CollectiveAdmission`, the ports an
installed firewall supplies so the layer checks every post the agent authors
and every gather before anything binds. Hosts and other domains read the schema
entrypoints `forms.ts` (send forms and the errors sends return), `inbound.ts`
(inbound items) and `message-text.ts` (the text parser) directly, so they never
load the operation layer. The other modules are private: `part/` encodes and
decodes the collective part, and `part/grammar.ts` admits a form's properties
under the MCP form-mode grammar; `validation.ts` checks answers against a form
keyword by keyword, with the string formats in `answer-formats.ts`,
`request-sends.ts` resolves members, times a send's wait for request posts and
settles a gather's request posts, `received-request.ts` matches an answer to
the request its id names in its conversation, or to the one request open
there, and `shared-answers.ts` builds an
all_gather's agreed result.
