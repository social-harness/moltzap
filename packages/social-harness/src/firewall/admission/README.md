# Message admission

Admission applies an assessment to endpoint state only while its captured
candidate, policy and evidence are still current. Evaluation runs outside the
store transaction. The commit then compares that capture before binding an
outgoing intent or publishing an incoming item.

When adding an item kind, define both the text to assess and the provenance
needed to check it. Collective results need separate treatment because their
answers can have different admission outcomes. Follow the resulting projection
through inbox reads, event lookup and notifications so each runtime path sees
the same committed disposition.

The [runtime admission rules](../../../../../docs/reference/spec/harness/message-policy.md)
define freshness, withholding and retained evidence.
