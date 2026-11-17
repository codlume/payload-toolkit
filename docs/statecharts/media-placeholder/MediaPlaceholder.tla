---- MODULE MediaPlaceholder ----
\* Ana works through Admin or REST (overrideAccess false, so Payload strips
\* fields whose update access is denied before the field hooks run).
\* "A script" calls the Local API with no user (overrideAccess true).
EXTENDS TLC

CONSTANT ActivityOn

OlderVersion == [image |-> "red", placeholder |-> "red"]

VARIABLES image, placeholder, lastModifiedBy, blurHashOn, restored, lastEditor
vars == <<image, placeholder, lastModifiedBy, blurHashOn, restored, lastEditor>>

\* value is what the caller sent. A restore reads the stored version instead.
BlurHashHook(removal, hasFile, restoring, value, previous, newImage) ==
  IF removal THEN "none"
  ELSE IF ~hasFile
    THEN IF restoring THEN OlderVersion.placeholder ELSE previous
  ELSE IF ~blurHashOn THEN "none"
  ELSE newImage

AttributionHook(user, previous) ==
  IF ~ActivityOn THEN previous
  ELSE IF user = "ana" THEN "ana" ELSE "nobody"

Init ==
  /\ image = OlderVersion.image
  /\ placeholder = OlderVersion.placeholder
  /\ lastModifiedBy = "ana"
  /\ blurHashOn = TRUE
  /\ restored = FALSE
  /\ lastEditor = "ana"

AnaUploadsImage ==
  /\ image' = "blue"
  /\ placeholder' = BlurHashHook(FALSE, TRUE, FALSE, "undefined", placeholder, "blue")
  /\ lastModifiedBy' = AttributionHook("ana", lastModifiedBy)
  /\ restored' = FALSE
  /\ lastEditor' = "ana"
  /\ UNCHANGED blurHashOn

AnaEditsMetadata ==
  /\ placeholder' = BlurHashHook(FALSE, FALSE, FALSE, "undefined", placeholder, "none")
  /\ lastModifiedBy' = AttributionHook("ana", lastModifiedBy)
  /\ lastEditor' = "ana"
  /\ UNCHANGED <<image, blurHashOn, restored>>

ScriptEditsMetadata ==
  /\ placeholder' = BlurHashHook(FALSE, FALSE, FALSE, "forged", placeholder, "none")
  /\ lastModifiedBy' = AttributionHook("nobody", lastModifiedBy)
  /\ lastEditor' = "script"
  /\ UNCHANGED <<image, blurHashOn, restored>>

AnaRemovesFile ==
  /\ image # "none"
  /\ image' = "none"
  /\ placeholder' = BlurHashHook(TRUE, FALSE, FALSE, "undefined", placeholder, "none")
  /\ lastModifiedBy' = AttributionHook("ana", lastModifiedBy)
  /\ restored' = FALSE
  /\ lastEditor' = "ana"
  /\ UNCHANGED blurHashOn

\* Field access strips the version's placeholder from Ana's data.
AnaRestoresVersion ==
  /\ image' = OlderVersion.image
  /\ placeholder' = BlurHashHook(FALSE, FALSE, TRUE, "undefined", placeholder, "none")
  /\ lastModifiedBy' = AttributionHook("ana", lastModifiedBy)
  /\ restored' = TRUE
  /\ lastEditor' = "ana"
  /\ UNCHANGED blurHashOn

ScriptRestoresVersion ==
  /\ image' = OlderVersion.image
  /\ placeholder' = BlurHashHook(FALSE, FALSE, TRUE, OlderVersion.placeholder, placeholder, "none")
  /\ lastModifiedBy' = AttributionHook("nobody", lastModifiedBy)
  /\ restored' = TRUE
  /\ lastEditor' = "script"
  /\ UNCHANGED blurHashOn

TurnBlurHashOff ==
  /\ blurHashOn
  /\ blurHashOn' = FALSE
  /\ UNCHANGED <<image, placeholder, lastModifiedBy, restored, lastEditor>>

TurnBlurHashOn ==
  /\ ~blurHashOn
  /\ blurHashOn' = TRUE
  /\ UNCHANGED <<image, placeholder, lastModifiedBy, restored, lastEditor>>

Next ==
  \/ AnaUploadsImage
  \/ AnaEditsMetadata
  \/ ScriptEditsMetadata
  \/ AnaRemovesFile
  \/ AnaRestoresVersion
  \/ ScriptRestoresVersion
  \/ TurnBlurHashOff
  \/ TurnBlurHashOn

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ image \in {"none", "red", "blue"}
  /\ placeholder \in {"none", "red", "blue", "forged"}
  /\ lastModifiedBy \in {"ana", "nobody", "forged"}
  /\ blurHashOn \in BOOLEAN
  /\ restored \in BOOLEAN
  /\ lastEditor \in {"ana", "script"}

PlaceholderMatchesImage == placeholder \in {"none", image}

CallerCannotWrite == placeholder # "forged" /\ lastModifiedBy # "forged"

RestoreBringsBackPlaceholder == restored => placeholder = OlderVersion.placeholder

AdminEditRecordsUser == ActivityOn /\ lastEditor = "ana" => lastModifiedBy = "ana"

UserlessEditRecordsNobody == ActivityOn /\ lastEditor = "script" => lastModifiedBy = "nobody"
====
