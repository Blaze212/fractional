# ADR 011 — The Generated Draft Is Shared With the NOTIFY_EMAILS List

**Status:** Accepted
**Date:** 2026-09-14
**Owner:** CareerSystems / adjuster
**Related spec:** none (follow-up to docs/specs/011-adjuster-mvp.md)

---

## Context

`generateDoc()` copies `TEMPLATE_DOC_ID` into `DRAFTS_FOLDER_ID` under the
script owner's account, then `notifyDraftReady()` mails the copy's URL to every
address in the `NOTIFY_EMAILS` script property. Drive access was never granted
to those addresses. Anyone on the list who is not the script owner, and who does
not already have access to the drafts folder through a separate folder-level
share, receives a link that opens on a request-access screen. The notification
is only useful to a recipient whose access happens to have been arranged by
hand outside the pipeline.

## Decision

`shareDraft(file)` runs immediately after `makeCopy()` in `generateDoc()`, and
adds every `NOTIFY_EMAILS` address to the new file with `addEditor()`.

Three properties of that call:

- **Editor, not viewer.** The draft's value is that an adjuster resolves its
  `[NEEDS INPUT]` placeholders and the yellow review markers in place. View
  access would force a copy and split the document the notification points at
  from the one being worked on.
- **At copy time, not beside `notifyDraftReady()`.** A run that fails on
  leftover tags returns early with a `docUrl` and never notifies. Sharing first
  means the document a failure points at is reachable by whoever has to look at
  why it failed.
- **Per recipient, inside a try/catch.** A domain sharing policy that refuses
  one external address, or a typo in the property, would otherwise cost the rest
  of the list its access and fail a draft that has already been rendered. Each
  refusal logs `docgen.share_failed` with the address and file id and the run
  continues.

Replay (`REPLAY_DOC_OPTIONS` in `replay.js`) opts out with `share: false`,
alongside the `notify: false` it already carried. A hand-run replay is a scratch
copy of a document nobody asked for, and it should not land in Brandon's Drive.

## Alternatives considered

- **Share `DRAFTS_FOLDER_ID` once, by hand, and let every draft inherit it.**
  Works, and is what the current deployment relies on implicitly. Rejected as
  the mechanism because it puts access in a Drive setting that no one on the
  team can see from the code, and it silently diverges from `NOTIFY_EMAILS` the
  moment someone edits the property. Note that this ADR does not undo a
  folder-level share if one exists: the file-level grant is additive.
- **`setSharing(ANYONE_WITH_LINK)` on the draft.** One call, no list to keep in
  sync, and no access requests. Rejected: the draft carries claim PII (insured
  name, loss address, inspection findings). ADR 007's amendment accepted a brief
  link-shared window on recording audio only because a third-party vendor could
  present no Google credential. Recipients here all have Google accounts, so
  there is no such forcing constraint.
- **A separate `SHARE_EMAILS` property.** Rejected as a second list to keep in
  step with the first. The people told a draft is ready and the people who need
  to open it are the same people, and one property keeps them that way.

## Consequences

- `NOTIFY_EMAILS` now controls document access, not only who receives mail.
  Removing an address stops the mail but does not revoke access to drafts
  already shared with it, and adding one grants access only to drafts generated
  after the change.
- Every pipeline run makes one `addEditor()` call per recipient, against the
  Drive quota rather than the mail quota.
- Recipients may see a Drive share notification in addition to
  `notifyDraftReady()`'s mail, depending on the account's Drive settings.
