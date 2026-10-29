# Policy evaluation

The evaluator assesses a message against captured evidence and returns
findings, guidance candidates and private audit data. Runtime admission and
offline experiments call the same factories. Neither caller needs to give a
middleware store or conversation capabilities.

When adding a finding or question stage, follow it through input validation,
chain composition and guidance projection. A provider's answer becomes useful
only after those steps establish its rule and subject references. Changes to
question meaning also need a new recorded edition so retained assessments can
be interpreted against the questions that produced them.

Use the public service factories for behavioral tests. The
[evaluation contract](../../../../../docs/reference/spec/harness/message-policy.md)
owns uncertainty, failure composition and evidence visibility.
