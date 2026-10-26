Remove the `autonomy` rule kind and evaluator stage, the `approval-required`
finding and refusal reason, and `MessageContext.authorization` approval evidence.
Owner approval uses norm guidance that asks the agent to ask its owner through
its host, such as `ask_user`; `seek-approval` remains valid norm feedback.
Persisted editable autonomy rules and message-policy `english.fixedRules` and
`initialRules` migrate to norms with "Ask your owner with ask_user before this."
prefixed to any existing guidance. Editable rules persist in their migrated form.
Retained audit v4 contexts accept and discard `authorization`; historical
`approval-required` judgments and findings decode as holds with
`unresolved-evidence`, and autonomy registration kinds decode as `norm`, so the
decisions feed remains readable. Retained collective-result projections map the
historical refusal reason to `unresolved-evidence` before inbox delivery. New checks and exports use the current values.
