# Roles escalation guards

payload-roles decides who can change a user's or a role's access. The first user to sign up becomes a super admin. After that, only a super admin can promote, demote, or remove a super admin, and the last one can never be demoted or removed. A manager can give or take a role only when they hold everything that role grants, which is why Ben loses most of his power over Cara once the editor role includes billing. Nobody but a super admin changes their own roles, and nobody resets the password of or removes someone stronger.

The model has three users (Ana, Ben, Cara) and three permission groups: content, people (manage users and roles), and billing, which only a super admin holds at the start. It has two roles: editor (content, and a super admin can add billing) and manager (content and people). Refused attempts change nothing, so the chart does not draw them. Each rule instead checks every attempt the code would allow in every reachable state, including attempts the chart does not draw.

```mermaid
---
title: "payload-roles: who can change a user's or role's access"
---
stateDiagram-v2
  direction LR
  state "Legend" as legend {
    lg0: Breaks NoStrippingOfStronger in some cases
    lg1: Path to the NoStrippingOfStronger bug
  }
  class lg0 mayBreak
  class lg1 bugPath
  state "At the same time" as all {
    state "Super admins" as r0 {
      s0: nobody yet
      s1: Ana only
      s2: Ana and Ben
      s3: Ben only
      [*] --> s0
      s0 --> s1: Ana signs up first
      s1 --> s2: a super admin makes Ben a super admin [after Ben signs up]
      s2 --> s1: a super admin demotes Ben or a super admin removes Ben
      s2 --> s3: a super admin demotes Ana or a super admin removes Ana
      s3 --> s2: Ben makes Ana a super admin again
    }
    --
    state "Ben" as r1 {
      s4: not signed up
      s5: no role
      s6: manager
      s7: removed
      [*] --> s4
      s4 --> s5: Ben and Cara sign up [after Ana]
      s5 --> s6: a super admin gives Ben manager
      s5 --> s7: a super admin removes Ben [when Super admins is not Ben only]
      s6 --> s5: a super admin takes manager from Ben
      s6 --> s7: a super admin removes Ben [when Super admins is not Ben only]
    }
    --
    state "Cara" as r2 {
      s8: not signed up
      s9: no role
      s10: editor
      s11: removed
      s12: editor and manager
      [*] --> s8
      s8 --> s9: Ben and Cara sign up [after Ana]
      s9 --> s10: a manager gives Cara editor [when Super admins is Ana only and Ben is manager and Editor role is content only]
      s10 --> s9: a manager takes editor from Cara [when Super admins is Ana only and Ben is manager and Editor role is content only]
      s10 --> s12: a manager gives Cara manager [when Super admins is Ana only and Ben is manager]
      s10 --> s11: a manager removes Cara [when Super admins is Ana only and Ben is manager and Editor role is content only]
      s12 --> s11: Cara removes herself, or Ben removes her
      s12 --> s10: a manager takes manager from Cara [when Super admins is Ana only and Ben is manager]
    }
    --
    state "Editor role" as r3 {
      s13: content only
      s14: content and billing
      [*] --> s13
      s13 --> s14: a super admin adds billing to the editor role [when Super admins is not nobody yet]
      s14 --> s13: a super admin takes billing off the editor role
    }
  }
  classDef mayBreak fill:#fff3e6,stroke:#e8730c,stroke-width:2.5px,color:#b85a06
  class s0 bugPath
  class s1 mayBreak
  class s1 bugPath
  class s4 bugPath
  class s5 bugPath
  class s6 mayBreak
  class s6 bugPath
  class s8 bugPath
  class s9 bugPath
  class s10 bugPath
  class s12 mayBreak
  class s12 bugPath
  class s13 bugPath
  class s14 mayBreak
  class s14 bugPath
```

## Rules

| Rule                     | In plain words                                                                                                                 | Result                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| `AlwaysASuperAdmin`      | Once someone has signed up, there is always at least one active super admin.                                                   | Holds                     |
| `OnlySuperAdminsPromote` | Nobody makes someone a super admin unless they are one.                                                                        | Holds                     |
| `NoOneGivesWhatTheyLack` | Nobody gives access they do not hold, by handing out a role or by widening a role someone already holds.                       | Holds                     |
| `NoOneTakesWhatTheyLack` | Nobody takes away access they do not hold, by taking a role off someone or by narrowing a role.                                | Holds                     |
| `NoSelfRoles`            | Nobody changes their own roles unless they are a super admin.                                                                  | Holds                     |
| `NoTakeoverOfStronger`   | Nobody resets the password of, or removes, a super admin or anyone who holds more than they do, unless they are a super admin. | Holds                     |
| `NoStrippingOfStronger`  | Nobody takes access away from someone who holds more than they do, unless they are a super admin.                              | Breaks: a design question |

Removing each guard from a copy of the spec broke its own rule, so no rule holds vacuously.

`NoStrippingOfStronger` is a candidate rule for the reviewer, not one the plugin claims. The README promises that an editor cannot weaken a stronger user's role. It does not promise that a manager cannot take a role away from a stronger user. The shortest path has 6 steps:

1. Ana signs up first.
2. Ben and Cara sign up.
3. A super admin gives Ben manager.
4. Ben gives Cara editor.
5. Ben gives Cara manager.
6. A super admin adds billing to the editor role.

Ben can now take manager away from Cara, although she holds billing and he does not. `decideUserWrite` in `packages/payload-roles/src/guards.ts` checks that he holds every grant of the role he removes, not everything Cara holds. A replay of this path against the plugin through the integration helpers let the removal through. The same replay refused, with `Forbidden`, Ben changing his own roles, taking editor from Cara, resetting Cara's password, taking billing off the editor role, deleting Cara, and deleting Ana, and it refused Ana demoting herself as the last super admin.

## What the model leaves out

- Concurrent requests. The README's non-atomic last-super-admin limit is not covered.
- Restoring a trashed user. Trash and delete are one "removes" step.
- Password and other account-field changes are checked as rules only, never drawn as steps.
- The "publish needs update" check, which [document-lifecycle.md](document-lifecycle.md) covers.
- Payload's collection access, reduced to "holds people".
- Malformed request bodies, missing roles, bulk writes, deleting a role, and role edits other than toggling billing on the editor role.
- Sign-up order is fixed: Ana first, then Ben and Cara together. Ana holds no roles, only Ana and Ben can be super admins, Ben can only be a manager, and one role changes per request.
- The chart hides 246 steps: a super admin's role changes and removals for Cara, Cara changing or removing Ben, a manager removing Cara while she has no role, Cara taking billing off the editor role, and Ben removing himself. It also does not draw the 28 steps that stay inside one chart state.

## Regenerate

From [`roles-guards/`](roles-guards/), with the `scripts/statechart` command of the pstack `statechart` skill:

```sh
statechart RolesGuards.tla --config RolesGuards.cfg --view view.mjs --out /tmp/roles-chart
```
