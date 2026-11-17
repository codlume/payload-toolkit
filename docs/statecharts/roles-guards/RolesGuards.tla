---- MODULE RolesGuards ----
EXTENDS FiniteSets, Naturals

People == {"Ana", "Ben", "Cara"}
Roles == {"editor", "manager"}
Cells == {"content", "people", "billing"}
ManagerGrants == {"content", "people"}
EditorChoices == {{"content"}, {"content", "billing"}}

VARIABLES status, sa, roles, editorGrants
vars == <<status, sa, roles, editorGrants>>

Active == {u \in People : status[u] = "active"}
SuperAdmins == {u \in Active : sa[u]}
Grants(r) == IF r = "editor" THEN editorGrants ELSE ManagerGrants

CapsOf(isSa, rs, eg) ==
  IF isSa THEN Cells
  ELSE UNION {IF r = "editor" THEN eg ELSE ManagerGrants : r \in rs}
Caps(u) == CapsOf(sa[u], roles[u], editorGrants)

CanWriteOthers(a) == sa[a] \/ "people" \in Caps(a)

SetSaOk(a, t, v) ==
  /\ a \in Active /\ t \in Active /\ sa[t] # v
  /\ a = t \/ CanWriteOthers(a)
  /\ sa[a]
  /\ ~(v = FALSE /\ Cardinality(SuperAdmins) <= 1)

SetRolesOk(a, t, rs) ==
  /\ a \in Active /\ t \in Active /\ rs # roles[t]
  /\ a = t \/ CanWriteOthers(a)
  /\ a = t => sa[a]
  /\ \A r \in (rs \ roles[t]) \cup (roles[t] \ rs) :
       Grants(r) \subseteq Caps(a)

SensitiveWriteOk(a, t) ==
  /\ a \in Active /\ t \in Active /\ a # t
  /\ CanWriteOthers(a)
  /\ sa[a] \/ (~sa[t] /\ Caps(t) \subseteq Caps(a))

RemoveOk(a, t) ==
  /\ a \in Active /\ t \in Active
  /\ CanWriteOthers(a)
  /\ ~(sa[t] /\ Cardinality(SuperAdmins) <= 1)
  /\ sa[a] \/ (~sa[t] /\ Caps(t) \subseteq Caps(a))

EditEditorOk(a, g) ==
  /\ a \in Active /\ g # editorGrants
  /\ CanWriteOthers(a)
  /\ editorGrants \subseteq Caps(a)
  /\ g \subseteq Caps(a)

Init ==
  /\ status = [u \in People |-> "absent"]
  /\ sa = [u \in People |-> FALSE]
  /\ roles = [u \in People |-> {}]
  /\ editorGrants = {"content"}

FirstSignUp ==
  /\ \A u \in People : status[u] = "absent"
  /\ status' = [status EXCEPT !["Ana"] = "active"]
  /\ sa' = [sa EXCEPT !["Ana"] = TRUE]
  /\ UNCHANGED <<roles, editorGrants>>

OthersSignUp ==
  /\ status["Ana"] = "active" /\ status["Ben"] = "absent"
  /\ status' = [u \in People |-> IF u = "Ana" THEN status[u] ELSE "active"]
  /\ UNCHANGED <<sa, roles, editorGrants>>

CanBeSuperAdmin == {"Ana", "Ben"}
RoleShapes(t) ==
  CASE t = "Ana" -> {{}}
    [] t = "Ben" -> {{}, {"manager"}}
    [] OTHER -> {{}, {"editor"}, {"editor", "manager"}}
OneRoleApart(t, rs) == Cardinality((rs \ roles[t]) \cup (roles[t] \ rs)) = 1

Actors(bySuperAdmin) == {a \in Active : sa[a] = bySuperAdmin}

Promote ==
  \E a \in People, t \in CanBeSuperAdmin : SetSaOk(a, t, TRUE)
    /\ sa' = [sa EXCEPT ![t] = TRUE] /\ UNCHANGED <<status, roles, editorGrants>>

Demote ==
  \E a, t \in People : SetSaOk(a, t, FALSE)
    /\ sa' = [sa EXCEPT ![t] = FALSE] /\ UNCHANGED <<status, roles, editorGrants>>

SuperAdminChangesRoles ==
  \E a \in Actors(TRUE), t \in People :
    \E rs \in RoleShapes(t) : OneRoleApart(t, rs) /\ SetRolesOk(a, t, rs)
      /\ roles' = [roles EXCEPT ![t] = rs] /\ UNCHANGED <<status, sa, editorGrants>>

SuperAdminRemoves ==
  \E a \in Actors(TRUE), t \in People : RemoveOk(a, t)
    /\ status' = [status EXCEPT ![t] = "removed"] /\ UNCHANGED <<sa, roles, editorGrants>>

SuperAdminEditsEditorRole ==
  \E a \in Actors(TRUE), g \in EditorChoices : EditEditorOk(a, g)
    /\ editorGrants' = g /\ UNCHANGED <<status, sa, roles>>

ManagerChangesRoles ==
  \E a \in Actors(FALSE), t \in People :
    \E rs \in RoleShapes(t) : OneRoleApart(t, rs) /\ SetRolesOk(a, t, rs)
      /\ roles' = [roles EXCEPT ![t] = rs] /\ UNCHANGED <<status, sa, editorGrants>>

ManagerRemoves ==
  \E a \in Actors(FALSE), t \in People : RemoveOk(a, t)
    /\ status' = [status EXCEPT ![t] = "removed"] /\ UNCHANGED <<sa, roles, editorGrants>>

ManagerEditsEditorRole ==
  \E a \in Actors(FALSE), g \in EditorChoices : EditEditorOk(a, g)
    /\ editorGrants' = g /\ UNCHANGED <<status, sa, roles>>

Next ==
  \/ FirstSignUp \/ OthersSignUp \/ Promote \/ Demote
  \/ SuperAdminChangesRoles \/ ManagerChangesRoles
  \/ SuperAdminRemoves \/ ManagerRemoves
  \/ SuperAdminEditsEditorRole \/ ManagerEditsEditorRole

Spec == Init /\ [][Next]_vars

AlwaysASuperAdmin == (\E u \in People : status[u] # "absent") => SuperAdmins # {}

OnlySuperAdminsPromote == \A a, t \in People : SetSaOk(a, t, TRUE) => sa[a]

NoOneGivesWhatTheyLack ==
  /\ \A a, t \in People, rs \in SUBSET Roles : SetRolesOk(a, t, rs) =>
       \/ sa[a]
       \/ CapsOf(sa[t], rs, editorGrants) \ Caps(t) \subseteq Caps(a)
  /\ \A a \in People, g \in EditorChoices : EditEditorOk(a, g) =>
       \A u \in Active : CapsOf(sa[u], roles[u], g) \ Caps(u) \subseteq Caps(a)

NoOneTakesWhatTheyLack ==
  /\ \A a, t \in People, rs \in SUBSET Roles : SetRolesOk(a, t, rs) =>
       \/ sa[a]
       \/ Caps(t) \ CapsOf(sa[t], rs, editorGrants) \subseteq Caps(a)
  /\ \A a \in People, g \in EditorChoices : EditEditorOk(a, g) =>
       \A u \in Active : Caps(u) \ CapsOf(sa[u], roles[u], g) \subseteq Caps(a)

NoSelfRoles == \A u \in People, rs \in SUBSET Roles : SetRolesOk(u, u, rs) => sa[u]

NoTakeoverOfStronger ==
  \A a, t \in People : a # t /\ (SensitiveWriteOk(a, t) \/ RemoveOk(a, t)) =>
    sa[a] \/ (~sa[t] /\ Caps(t) \subseteq Caps(a))

NoStrippingOfStronger ==
  \A a, t \in People, rs \in SUBSET Roles : SetRolesOk(a, t, rs) /\ a # t =>
    \/ sa[a]
    \/ Caps(t) \ CapsOf(sa[t], rs, editorGrants) = {}
    \/ Caps(t) \subseteq Caps(a)
====
