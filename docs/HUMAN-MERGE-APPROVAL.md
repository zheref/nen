# Named human merge approval

A solo maintainer can opt into `"approval_policy": "merge-is-approval"`.
Keep exactly one name in `default_approvers`, declared in `reviewers` with
`"kind": "human"` and a whole literal login pattern such as `"^solo-maintainer$"`.
Missing, empty, undeclared, bot, multiple, or ambiguous identities are refused.
Keep the independent review providers in `base_reviewers`; naming the human there
still requires their review round, because this policy changes only the approval limb.

On that human's own PR (GitHub must identify the author as a User), readiness
retains the approver and says **ready for the human merge decision**. It explicitly
states that no review approval or merge has occurred. Required checks, reviewer
rounds, conditional approvers and thread conditions remain binding. For another
author, the named human's ordinary approval remains required.

After a merge, `pr ready` reports the merge as the human approval decision only
when GitHub's `mergedBy` User matches the declared identity and the gate declaration
was read successfully. A different, missing, or bot merger is not confirmed as human
approval; a closed PR is never approval. Terminal exit code 10 stays unchanged.
This records the GitHub actor; it cannot distinguish a person from software using
that person's credentials. No review is created, and Nen's bounded agent merge
routes refuse this policy. Repositories without this explicit opt-in keep their
existing behavior. Consumer adoption follows a release containing this capability.

