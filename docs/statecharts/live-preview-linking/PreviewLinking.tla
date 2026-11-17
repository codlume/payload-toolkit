---- MODULE PreviewLinking ----
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS Blocks, MaxInFlight
None == "none"
Msgs == {"ready", "ack"} \cup Blocks

VARIABLES
  aLinked,
  aAwaitsLoad,
  aSel,
  aFind,
  aLit,
  pPhase,
  pFind, pLit,
  toA, toP,    \* postMessage queues, FIFO per direction
  aFindStale,
  pFindStale,
  aSelKept,
  selStale

vars == <<aLinked, aAwaitsLoad, aSel, aFind, aLit, pPhase, pFind, pLit, toA, toP,
          aFindStale, pFindStale, aSelKept, selStale>>

Init ==
  /\ aLinked = FALSE /\ aAwaitsLoad = TRUE /\ aSel = None /\ aFind = {} /\ aLit = None
  /\ pPhase = "loading" /\ pFind = {} /\ pLit = None
  /\ toA = <<>> /\ toP = <<>>
  /\ aFindStale = FALSE /\ pFindStale = FALSE /\ aSelKept = FALSE /\ selStale = FALSE

KeepAdminFlags ==
  /\ aFindStale' = (aFindStale /\ aFind' = aFind)
  /\ aSelKept' = (aSelKept /\ aSel' = aSel)
  /\ selStale' = (selStale /\ aSel' = aSel)
KeepPreviewFlag == pFindStale' = (pFindStale /\ pFind' = pFind)
KeepFlags == KeepAdminFlags /\ KeepPreviewFlag

PreviewPageStarts ==
  /\ pPhase = "loading"
  /\ pPhase' = "waiting"
  /\ toA' = Append(toA, "ready")
  /\ UNCHANGED <<aLinked, aAwaitsLoad, aSel, aFind, aLit, pFind, pLit, toP>>
  /\ KeepFlags

AdminSeesLoad ==
  /\ aAwaitsLoad
  /\ aAwaitsLoad' = FALSE
  /\ aLinked' = FALSE /\ aSel' = None /\ aFind' = {} /\ aLit' = None
  /\ toP' = Append(toP, "ready")
  /\ UNCHANGED <<pPhase, pFind, pLit, toA>>
  /\ KeepFlags

\* A new document replaces the old one: its state and messages bound for it are gone.
YouReloadPreview ==
  /\ ~aAwaitsLoad
  /\ aAwaitsLoad' = TRUE
  /\ pPhase' = "loading" /\ pFind' = {} /\ pLit' = None
  /\ toP' = <<>>
  /\ UNCHANGED <<aLinked, aSel, aFind, aLit, toA>>
  /\ aFindStale' = aFindStale /\ aSelKept' = aSelKept /\ KeepPreviewFlag
  /\ selStale' = (aSel # None)

AdminUnchanged == UNCHANGED <<aAwaitsLoad, pPhase, pFind, pLit>> /\ KeepPreviewFlag

AdminGetsReady ==
  /\ toA # <<>> /\ Head(toA) = "ready" /\ toA' = Tail(toA)
  /\ toP' = Append(toP, "ack")
  /\ IF aLinked
       THEN /\ aFind' = {} /\ aLit' = None /\ aSel' = None
            /\ UNCHANGED aLinked
       ELSE /\ aLinked' = TRUE
            /\ UNCHANGED <<aSel, aFind, aLit>>
  /\ KeepAdminFlags
  /\ AdminUnchanged

AdminGetsAck ==
  /\ toA # <<>> /\ Head(toA) = "ack" /\ toA' = Tail(toA)
  /\ aLinked' = TRUE
  /\ UNCHANGED <<aSel, aFind, aLit, toP>>
  /\ KeepAdminFlags
  /\ AdminUnchanged

AdminGetsLocate ==
  /\ toA # <<>> /\ Head(toA) \in Blocks /\ toA' = Tail(toA)
  /\ IF aLinked
       THEN /\ aLit' = None /\ aSel' = None /\ aFind' = {Head(toA)}
            /\ UNCHANGED <<aLinked, toP>>
            /\ aFindStale' = FALSE
            /\ aSelKept' = (aSel' # None /\ aSel' # Head(toA))
            /\ selStale' = (selStale /\ aSel' = aSel)
       ELSE /\ UNCHANGED <<aLinked, aSel, aFind, aLit, toP>>
            /\ KeepAdminFlags
  /\ AdminUnchanged

PreviewUnchanged == UNCHANGED <<aLinked, aAwaitsLoad, aSel, aFind, aLit>> /\ KeepAdminFlags

PreviewGetsReady ==
  /\ toP # <<>> /\ Head(toP) = "ready" /\ toP' = Tail(toP)
  /\ CASE pPhase = "loading" -> UNCHANGED <<pPhase, pFind, pLit, toA>>
       [] pPhase = "waiting" ->
            /\ pPhase' = "linked" /\ toA' = Append(toA, "ack")
            /\ UNCHANGED <<pFind, pLit>>
       [] pPhase = "linked" ->
            /\ pFind' = {} /\ pLit' = None /\ toA' = Append(toA, "ack")
            /\ UNCHANGED pPhase
  /\ KeepPreviewFlag
  /\ PreviewUnchanged

PreviewGetsAck ==
  /\ toP # <<>> /\ Head(toP) = "ack" /\ toP' = Tail(toP)
  /\ pPhase' = IF pPhase = "loading" THEN "loading" ELSE "linked"
  /\ UNCHANGED <<pFind, pLit, toA>>
  /\ KeepPreviewFlag
  /\ PreviewUnchanged

PreviewGetsLocate ==
  /\ toP # <<>> /\ Head(toP) \in Blocks /\ toP' = Tail(toP)
  /\ IF pPhase = "linked"
       THEN /\ pLit' = None /\ pFind' = {Head(toP)} /\ pFindStale' = FALSE
            /\ UNCHANGED <<pPhase, toA>>
       ELSE /\ UNCHANGED <<pPhase, pFind, pLit, toA>>
            /\ KeepPreviewFlag
  /\ PreviewUnchanged

YouFocusAdminField(b) ==
  /\ aLinked
  /\ b # aSel
  /\ aFind' = {} /\ aLit' = None
  /\ toP' = Append(toP, b)
  /\ aSel' = b
  /\ UNCHANGED <<aLinked, aAwaitsLoad, pPhase, pFind, pLit, toA>>
  /\ aFindStale' = (aFind' # {} /\ aFind' # {b})
  /\ aSelKept' = FALSE /\ selStale' = FALSE /\ KeepPreviewFlag

YouClickPreviewBlock(b) ==
  /\ pPhase = "linked"
  /\ toA' = Append(toA, b)
  /\ UNCHANGED <<aLinked, aAwaitsLoad, aSel, aFind, aLit, pPhase, pFind, pLit, toP>>
  /\ pFindStale' = (pFind' # {} /\ pFind' # {b})
  /\ KeepAdminFlags

AdminFindsBlock ==
  /\ aFind # {}
  /\ aLit' = (CHOOSE b \in aFind : TRUE)
  /\ aFind' = {}
  /\ UNCHANGED <<aLinked, aAwaitsLoad, aSel, pPhase, pFind, pLit, toA, toP>>
  /\ KeepFlags

AdminGivesUp ==
  /\ aFind # {}
  /\ aFind' = {}
  /\ UNCHANGED <<aLinked, aAwaitsLoad, aSel, aLit, pPhase, pFind, pLit, toA, toP>>
  /\ KeepFlags

AdminHighlightFades ==
  /\ aLit # None
  /\ aLit' = None
  /\ UNCHANGED <<aLinked, aAwaitsLoad, aSel, aFind, pPhase, pFind, pLit, toA, toP>>
  /\ KeepFlags

PreviewFindsBlock ==
  /\ pFind # {}
  /\ pLit' = (CHOOSE b \in pFind : TRUE)
  /\ pFind' = {}
  /\ UNCHANGED <<aLinked, aAwaitsLoad, aSel, aFind, aLit, pPhase, toA, toP>>
  /\ KeepFlags

PreviewGivesUp ==
  /\ pFind # {}
  /\ pFind' = {}
  /\ UNCHANGED <<aLinked, aAwaitsLoad, aSel, aFind, aLit, pPhase, pLit, toA, toP>>
  /\ KeepFlags

PreviewHighlightFades ==
  /\ pLit # None
  /\ pLit' = None
  /\ UNCHANGED <<aLinked, aAwaitsLoad, aSel, aFind, aLit, pPhase, pFind, toA, toP>>
  /\ KeepFlags

Next ==
  \/ PreviewPageStarts \/ AdminSeesLoad \/ YouReloadPreview
  \/ AdminGetsReady \/ AdminGetsAck \/ AdminGetsLocate
  \/ PreviewGetsReady \/ PreviewGetsAck \/ PreviewGetsLocate
  \/ \E b \in Blocks : YouFocusAdminField(b)
  \/ \E b \in Blocks : YouClickPreviewBlock(b)
  \/ AdminFindsBlock \/ AdminGivesUp \/ AdminHighlightFades
  \/ PreviewFindsBlock \/ PreviewGivesUp \/ PreviewHighlightFades

Spec == Init /\ [][Next]_vars

BlockSymmetry == Permutations(Blocks)

QueueBound == Len(toA) <= MaxInFlight /\ Len(toP) <= MaxInFlight

TypeOK ==
  /\ aLinked \in BOOLEAN /\ aAwaitsLoad \in BOOLEAN
  /\ aSel \in Blocks \cup {None} /\ aLit \in Blocks \cup {None} /\ pLit \in Blocks \cup {None}
  /\ aFind \subseteq Blocks /\ pFind \subseteq Blocks
  /\ pPhase \in {"loading", "waiting", "linked"}
  /\ toA \in Seq(Msgs) /\ toP \in Seq(Msgs)
  /\ {aFindStale, pFindStale, aSelKept, selStale} \subseteq BOOLEAN

OneFindPerSide == Cardinality(aFind) <= 1 /\ Cardinality(pFind) <= 1

NothingBeforeLink ==
  /\ ~aLinked => (aSel = None /\ aFind = {} /\ aLit = None)
  /\ pPhase # "linked" => (pFind = {} /\ pLit = None)

AdminPickCancelsFind == ~aFindStale

PreviewClickCancelsFind == ~pFindStale

PreviewClickClearsSelection == ~aSelKept

ReloadClearsSelection == selStale => pPhase # "linked"
====
