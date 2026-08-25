# Auto-approval rules

This file defines rules Gitar should use to auto-approve merge requests in this
repository. Each rule has a natural-language `When` condition and an `Action`.

Dependency updates are out of scope here. Renovate labels its own non-major MRs
`automerge`, and the Renovate job approves and merges them.

## Rule: Documentation-only changes

**When:** Every changed file in the merge request is a Markdown file (`.md`) or
`catalog-info.yaml`, and the merge request does not touch source code,
`config/`, CI configuration, the `Dockerfile`, or dependency manifests.

**Action:** Approve the merge request automatically and add the label
`auto-approved`.

## Rule: Test-only changes

**When:** Every changed file in the merge request is under `test/`, and the
merge request does not modify any endpoint module, `config/`, CI configuration,
the `Dockerfile`, or dependency manifests.

**Action:** Approve the merge request automatically and add the label
`auto-approved`.

## Rule: Re-approve after rebase

**When:** The merge request was previously approved by at least one human
reviewer, and the approval was reset solely because the author rebased or
force-pushed. The substantive diff relative to the target branch is identical
to the version that received the original approval, and no new commits with new
logic or content were added since that approval.

**Action:** Approve the merge request automatically and add the label
`auto-approved`.

## Rule: Safe, backwards-compatible change

**When:** All of the following hold for the merge request:

- **CI is green.** The pipeline for the latest commit has completed
  successfully, with no failing, running, or pending required jobs.
- **Tests cover the change if needed.** New or changed endpoint behavior has a
  matching case under `test/`. Changes that genuinely need no tests, such as
  comments or log text, may omit them.
- **The diff matches the MR description.** The code changes do exactly what the
  title and description say, with no unexplained or unrelated changes bundled
  in.
- **The change is backwards compatible.** Adding new behavior is fine: new
  endpoints, new request parameters, new response fields, new error cases, new
  session headers, or new spec fixtures. What is not allowed is breaking what
  already exists. Do not auto-approve a removed or renamed endpoint, request
  parameter, response field, status code, error code, or session header, and do
  not auto-approve a change to an existing response shape or quota rule. Every
  DeepL client library runs its own tests against this mock, so a break here
  breaks their pipelines.
- **No regression or change to existing behavior.** New behavior may be added
  freely, but the observable behavior of existing endpoints must stay as it is.

**Action:** Approve the merge request automatically and add the label
`auto-approved`.

> Apply this rule strictly: only approve when the merge request **clearly and
> unambiguously** satisfies every condition above. If any condition is
> uncertain, leave the merge request for human review.

## Rule: Everything else

**When:** The merge request does not clearly satisfy one of the rules above.
This includes CI configuration (`.gitlab-ci.yml`), the `Dockerfile`,
`.auto-approve.yaml`, `.gitar/**`, and a release cut, which changes `version`
in `package.json` and moves the `[Unreleased]` section of `CHANGELOG.md`.

**Action:** Do not auto-approve. Leave the merge request for human review.
