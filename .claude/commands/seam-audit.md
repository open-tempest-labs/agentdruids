Run the `seam-auditor` subagent over the current branch diff, then record that it ran so the pre-push gate is satisfied.

This is the audit the pre-push hook requires when a branch changes a shared representation — a migration, a type under `src/models/`, or an added/removed export. It exists because that class of change has repeatedly shipped with a consumer left un-traced.

## Steps

1. Determine the branch diff: `git diff --stat upstream/main...HEAD` (fall back to `origin/main`). If there is no diff, say so and stop.

2. Establish what representation changed. Be specific — "agents gained a `slug_id` column", "`accessibleRealms` entries may now be objects", "`get_step_content` is addressed by producer rather than content id". If nothing representational changed, say so and stop; do not record a marker for a diff that did not need one.

3. Launch the `seam-auditor` subagent with:
   - the statement of what changed, from step 2
   - the output of `git diff upstream/main...HEAD`
   - an instruction to enumerate **every producer and consumer** of the changed representation and report those the diff fails to handle

4. Report its findings to the user in full. Do not summarise away a finding because it looks minor — the defects this catches have consistently looked minor.

5. For each finding, either fix it or state plainly why it does not apply. Do not record the marker while a finding is unaddressed and unexplained.

6. Record the audit against the exact commit:

   ```
   git rev-parse HEAD > .claude/.seam-audit
   ```

   If commits are amended afterwards, the marker no longer matches and the audit must be re-run. That is intentional.

## What this does not do

Recording the marker proves an audit ran against this commit. It does not prove the audit was thorough, and nothing stops the marker being written without doing the work. It is a forcing function against forgetting, not a guarantee of correctness — say so if asked to vouch for a diff on the strength of the marker alone.
