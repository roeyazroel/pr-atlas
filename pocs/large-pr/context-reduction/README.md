# Deterministic context-reduction PoC

Hypothesis: Atlas can keep one provider call while removing formatting churn and
ranking exact changed-line evidence under a fixed byte budget. Every changed
file remains represented, so reduction is auditable rather than silent.

```sh
node --test pocs/large-pr/context-reduction/reduce.node-test.mjs
node pocs/large-pr/context-reduction/reduce.mjs <atlas-input-dir> /tmp/reduced.json 120000
```

The report includes compression ratio, complete changed-file coverage, detailed
evidence coverage, exact evidence locators, dropped-context reasons, and a rough
single-provider latency proxy. The replayable JSON can be used as a controlled
provider input.

Risks: semantic lines can depend on surrounding unchanged context; ranking may
underweight cross-file relationships; formatting detection is deliberately
conservative and should never replace final source/evidence validation.
