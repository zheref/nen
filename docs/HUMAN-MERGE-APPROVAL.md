# Named human merge approval

A solo maintainer can opt into `"approval_policy": "merge-is-approval"`.
Keep exactly one name in `default_approvers`, declared in `reviewers` with
`"kind": "human"` and a whole literal login pattern such as `"^solo-maintainer$"`.
Missing, empty, undeclared, bot, multiple, or ambiguous identities are refused.
Reviewer aliases must have no commas or surrounding whitespace, so the round
transport retains every configured identity.
Keep the independent review providers in `base_reviewers`; naming the human there
still requires their review round, because this policy changes only the approval limb.

On that human's own PR (GitHub must identify the author as a User), readiness
retains the approver and says **ready for the human merge decision**. It explicitly
states that no human approval is inferred and no merge has occurred. Required checks, reviewer
rounds, conditional approvers and thread conditions remain binding. For another
author, the named human's ordinary approval remains required.

After a merge, `pr ready` reports the merge as the human approval decision only
when GitHub's `mergedBy` User matches the declared identity and the gate declaration
was read successfully from the recorded PR base or an explicit external caller-supplied
file. The report names that source and qualifies the approval under that declaration;
it does not claim to have verified which policy was in force at merge time. An
alternate checkout-local file cannot establish approval. A different, missing, or bot merger is not confirmed as human
approval; a closed PR is never approval. Terminal exit code 10 stays unchanged.
This records the GitHub actor; it cannot distinguish a person from software using
that person's credentials. No review is created, and Nen's bounded agent merge
routes refuse this policy. Repositories without this explicit opt-in keep their
existing behavior. Consumer adoption follows a release containing this capability.
