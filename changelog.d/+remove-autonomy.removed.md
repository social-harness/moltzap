Breaking harness interface change: remove the `autonomy` rule kind and evaluator
stage, the `approval-required` finding and refusal reason, and
`MessageContext.authorization` approval evidence. The narrowed `policy_update`
and `policy_read` schemas accept only `safety` and `norm` rule kinds. The
`FirewallSendError` refusal union and withheld reasons accept only `prohibited`,
`unresolved-evidence`, `check-unavailable` and `norm-violation`. Live
`MessageContext` decoding refuses `authorization`.

`Daemon.withFirewall` and `makeEnglishPolicy` refuse `autonomy` rules. Only
message-policy files (`english.fixedRules` and `initialRules`) and persisted
editable documents migrate those rules to `safety`, preserving their ids, text
and guidance. Feedback survives only when safety permits its next action;
otherwise the default applies. Editable migrations persist and produce an
activation and startup log listing the migrated ids. No `ask_user` guidance is
added. Owner approval can be expressed through norm guidance and
`seek-approval` norm feedback.

The default unresolved-evidence feedback is “Required policy evidence is missing
or uncertain. The message was not admitted. Wait for the evidence and resend, or
revise the message.” The default unavailable-check feedback is “A required policy
check is unavailable. The message was not admitted. Wait for the check to become
available and resend, or revise the message.” The `questionEdition` moves to
`firewall-english-v2`, changing every English `activeRevision`.

Retained audit v4 contexts discard `authorization`; historical
`approval-required` judgments and findings decode as settled holds with
`unresolved-evidence`, and retained autonomy registration kinds decode as
`safety`. Retained collective-result projections and webhook outbox bodies map
that refusal reason to `unresolved-evidence` before delivery. New checks and
exports use the current values.
