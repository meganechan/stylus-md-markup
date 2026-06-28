# Desk gives feedback (typed comment + pen), never edits the document

> Status: accepted — supersedes ADR-0001

Review Desk displays the markdown **read-only**. The Reviewer's feedback is two optional, mixable channels: (1) a **free-form typed comment** ("read the md, type whatever you think") and (2) **pen / ink marks** over the rendered md. The desk **never edits the md** — the Asker owns the document and revises it across Rounds based on the feedback.

**Why:** Tony wants natural review (read → comment / scribble), not structured inline editing. Keeping the md Asker-owned matches the multi-round revise-and-resubmit loop and removes the need for a text editor on the desk. This reverses ADR-0001 on three points: ink is now allowed (incl. for markdown), span-anchoring + intent-chips are no longer required (a free comment suffices), and inline md editing is explicitly out of scope.

**Consequence:** Decision payload to the Asker = `{ outcome, comment?, ink? }` — **no edited md** (the Asker already holds its own md and revises it itself on `return`). Because feedback shape (comment/ink, later ui) will evolve, the maw backend treats the feedback portion as **opaque pass-through** and does not interpret it.

**Repo:** because pen requires an ink engine, Review Desk **folds into the `stylus` (ink) repo** rather than a standalone `review-desk` repo — reuse the existing ink engine instead of rebuilding it. (Reverses the earlier separate-repo call; the altitude objection weakens once review itself needs ink.)
