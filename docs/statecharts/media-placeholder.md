# Media placeholder and Last Modified By

A media document in the demo app has three independent parts: its BlurHash placeholder, its `Last Modified By` name, and whether BlurHash generation is on. The placeholder always matches the current image or is empty, and no caller can write the placeholder or the name directly. Every change Ana makes records Ana, and every change without a user clears the name. A restore brings back the older version's placeholder, whether an editor restores through Admin or REST or a server script restores. All rules hold.

```mermaid
---
title: "Media placeholder and Last Modified By"
---
stateDiagram-v2
  direction LR
  state "At the same time" as all {
    state "Placeholder" as r0 {
      s0: Placeholder from current image
      s1: No placeholder
      [*] --> s0
      s0 --> s1: Ana removes the file
      s1 --> s0: Ana uploads a different image [when BlurHash is On]
      s1 --> s0: Ana restores the older version in the admin or a server script restores the older version
      s0 --> s1: Ana uploads a different image [when BlurHash is Off]
    }
    --
    state "Last modified by" as r1 {
      s2: Last modified by Ana
      s3: Nobody recorded
      [*] --> s2
      s2 --> s3: a script edits the metadata without a user, sending its own placeholder and name or a server script restores the older version
      s3 --> s2: Ana uploads a different image or Ana removes the file or Ana restores the older version in the admin
    }
    --
    state "BlurHash" as r2 {
      s4: On
      s5: Off
      [*] --> s4
      s4 --> s5: the maintainer turns BlurHash off
      s5 --> s4: the maintainer turns BlurHash on
    }
  }
```

## Rules

| Rule                           | In plain words                                                                        | Result |
| ------------------------------ | ------------------------------------------------------------------------------------- | ------ |
| `PlaceholderMatchesImage`      | The placeholder always matches the current image or is empty, never an older image's. | Holds  |
| `CallerCannotWrite`            | A caller can never write the placeholder or the name directly.                        | Holds  |
| `RestoreBringsBackPlaceholder` | Restoring a version brings back that version's placeholder.                           | Holds  |
| `AdminEditRecordsUser`         | An edit by an admin user records that user.                                           | Holds  |
| `UserlessEditRecordsNobody`    | An edit with no user clears the name, so an earlier editor is not shown.              | Holds  |

Field access strips the placeholder from an editor's restore data, because no caller can write it. So the restore branch of the BlurHash field hook reads the placeholder from the stored version that Payload restores, not from the caller's data. Before [#133](https://github.com/codlume/payload-toolkit/issues/133), it read the caller's data, and an editor's restore lost the placeholder.

## What the model leaves out

- Only one older version exists, the first upload. Versions saved without a placeholder are not modelled.
- Drafts, autosave, duplicates, and uploads that cannot be decoded are left out. Undecodable uploads store an empty placeholder.
- Activity is always on, as in `apps/payload-cms/src/app-config.ts`. Set `ActivityOn = FALSE` in the config to model the disabled plugin.
- The Site Settings global's restore hook, users from other auth collections, nested writes, S3 storage, and concurrent writes.
- The chart hides "Ana edits the metadata". Its only visible move, from `Nobody recorded` to `Last modified by Ana`, repeats Ana's other arrows.

## Regenerate

From [`media-placeholder/`](media-placeholder/), with the `scripts/statechart` command of the pstack `statechart` skill:

```sh
statechart MediaPlaceholder.tla --config MediaPlaceholder.cfg --view view.mjs --out /tmp/media-chart
```
