---------------------------- MODULE DocumentLifecycle ----------------------------
EXTENDS FiniteSets

CONSTANTS
  Always,
  Optional

VARIABLES
  doc,
  grants,
  lastAttempt

vars == <<doc, grants, lastAttempt>>

Doc(stage, published, trashed, pending, hasPublishedVersion) ==
  [stage |-> stage, published |-> published, trashed |-> trashed,
   pending |-> pending, hasPublishedVersion |-> hasPublishedVersion]

Absent == Doc("absent", FALSE, FALSE, FALSE, FALSE)
Gone   == Doc("gone", FALSE, FALSE, FALSE, FALSE)
Row(published, trashed, hasPublishedVersion) == Doc("exists", published, trashed, FALSE, hasPublishedVersion)

Exists  == doc.stage = "exists"
Live(r) == r.stage = "exists" /\ r.published /\ ~r.trashed

ValidGrants == {Always \cup g : g \in {s \in SUBSET Optional :
                  "publish" \in s \cup Always => "update" \in s \cup Always}}

Base(write) ==
  CASE write = "create"        -> {"create"}
    [] write = "edit"          -> {"update"}
    [] write = "lifecycleOnly" -> {}
    [] write = "restore"       -> {"readVersions", "update"}

TransitionActions(write, writesMain, before, judged) ==
  IF ~writesMain
  THEN Base(write)
       \cup (IF write = "lifecycleOnly" THEN {"update"} ELSE {})
       \cup (IF judged.trashed THEN {"trash"} ELSE {})
  ELSE LET trashMoves == before.trashed # judged.trashed IN
       Base(write)
       \cup (IF write = "lifecycleOnly" /\ ~trashMoves /\ Live(before) = Live(judged)
             THEN {"update"} ELSE {})
       \cup (IF trashMoves THEN {"trash"}
             ELSE IF Live(before) /\ ~Live(judged) THEN {"unpublish"} ELSE {})
       \cup (IF Live(judged)
             THEN {"publish"} \cup (IF write # "create" THEN {"update"} ELSE {})
             ELSE {})

Try(needs, next) ==
  LET ok == needs \subseteq grants IN
  /\ doc' = IF ok THEN next ELSE doc
  /\ lastAttempt' = [from |-> doc, ok |-> ok, needs |-> IF ok THEN needs ELSE {}]
  /\ UNCHANGED grants

Init ==
  /\ doc = Absent
  /\ grants \in ValidGrants
  /\ lastAttempt = [from |-> Absent, ok |-> TRUE, needs |-> {}]

CreateDraft == doc.stage = "absent" /\
  Try(TransitionActions("create", TRUE, doc, Row(FALSE, FALSE, FALSE)), Row(FALSE, FALSE, FALSE))

CreatePublished == doc.stage = "absent" /\
  Try(TransitionActions("create", TRUE, doc, Row(TRUE, FALSE, TRUE)), Row(TRUE, FALSE, TRUE))

\* A draft save or autosave writes only a version.
SaveDraft == Exists /\ ~doc.trashed /\
  Try(TransitionActions("edit", FALSE, doc, Row(FALSE, FALSE, doc.hasPublishedVersion)),
      [doc EXCEPT !.pending = doc.published])

Publish == Exists /\ ~doc.trashed /\
  Try(TransitionActions("edit", TRUE, doc, Row(TRUE, FALSE, TRUE)), Row(TRUE, FALSE, TRUE))

\* A non-draft save without _status takes the latest version's status.
SaveWithoutDraftMode == Exists /\ ~doc.trashed /\
  LET after == Row(doc.published /\ ~doc.pending, FALSE, doc.hasPublishedVersion) IN
  Try(TransitionActions("edit", TRUE, doc, after), after)

Unpublish == Live(doc) /\
  Try(TransitionActions("lifecycleOnly", TRUE, doc, Row(FALSE, FALSE, doc.hasPublishedVersion)), Row(FALSE, FALSE, doc.hasPublishedVersion))

\* {deletedAt}; Payload fills _status from the latest version.
MoveToTrash == Exists /\ ~doc.trashed /\
  LET after == Row(doc.published /\ ~doc.pending, TRUE, doc.hasPublishedVersion) IN
  Try(TransitionActions("lifecycleOnly", TRUE, doc, after), after)

RestoreFromTrashAsDraft == Exists /\ doc.trashed /\
  Try(TransitionActions("lifecycleOnly", TRUE, doc, Row(FALSE, FALSE, doc.hasPublishedVersion)), Row(FALSE, FALSE, doc.hasPublishedVersion))

RestoreFromTrashAsPublished == Exists /\ doc.trashed /\
  Try(TransitionActions("lifecycleOnly", TRUE, doc, Row(TRUE, FALSE, TRUE)), Row(TRUE, FALSE, TRUE))

DeleteForGood == Exists /\ Try({"delete"}, Gone)

\* Payload refuses a version restore while the document is in the trash.
RestorePublishedVersion == Exists /\ ~doc.trashed /\ doc.hasPublishedVersion /\
  Try(TransitionActions("restore", TRUE, doc, Row(TRUE, FALSE, TRUE)), Row(TRUE, FALSE, TRUE))

RestoreDraftVersion == Exists /\ ~doc.trashed /\
  Try(TransitionActions("restore", TRUE, doc, Row(FALSE, FALSE, doc.hasPublishedVersion)), Row(FALSE, FALSE, doc.hasPublishedVersion))

\* Restore with draft=true writes only a version.
RestoreVersionAsDraft == Exists /\ ~doc.trashed /\
  Try(TransitionActions("restore", FALSE, doc, Row(FALSE, FALSE, doc.hasPublishedVersion)),
      [doc EXCEPT !.pending = doc.published])

RoleChanges ==
  /\ grants' \in ValidGrants \ {grants}
  /\ lastAttempt' = [from |-> doc, ok |-> TRUE, needs |-> {}]
  /\ UNCHANGED doc

Done == doc.stage = "gone" /\ UNCHANGED vars

Next ==
  \/ CreateDraft \/ CreatePublished
  \/ SaveDraft \/ Publish \/ SaveWithoutDraftMode \/ Unpublish
  \/ MoveToTrash \/ RestoreFromTrashAsDraft \/ RestoreFromTrashAsPublished \/ DeleteForGood
  \/ RestorePublishedVersion \/ RestoreDraftVersion \/ RestoreVersionAsDraft
  \/ RoleChanges \/ Done

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
RefusedMoveChangesNothing == ~lastAttempt.ok => doc = lastAttempt.from

GoesLiveOnlyWithPublish ==
  (Live(doc) /\ ~Live(lastAttempt.from)) =>
    /\ "publish" \in grants
    /\ (lastAttempt.from.stage = "absent" \/ "update" \in grants)

TakingDownNeedsUnpublishTrashOrDelete ==
  (Live(lastAttempt.from) /\ ~Live(doc)) =>
    \/ "unpublish" \in grants
    \/ (doc.trashed /\ "trash" \in grants)
    \/ (doc.stage = "gone" /\ "delete" \in grants)

PublishNeverWithoutUpdate == "publish" \in grants => "update" \in grants

PendingDraftOnlyOverLive == doc.pending => Live(doc)
=============================================================================
