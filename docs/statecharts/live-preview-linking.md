# Live preview linking

The Admin form and the Live Preview iframe each start unlinked, link after the ready and ack handshake, and then find and highlight blocks. Nothing happens on either side before both have linked. A reload sends both back to unlinked and clears the Admin selection and any pending find, so no stale timeout fires later. Focusing a field in Admin cancels Admin's own pending find, and a click reported from the preview makes Admin forget its selection. The red state is a real defect, [#134](https://github.com/codlume/payload-toolkit/issues/134). A click in the preview does not cancel the preview's own pending find, so for up to 2 seconds the preview can jump to an older block than the one you clicked.

```mermaid
---
title: "Live Preview linking: Admin form and preview iframe"
---
stateDiagram-v2
  direction LR
  state "Legend" as legend {
    lg0: Breaks PreviewClickCancelsFind
    lg1: Path to the PreviewClickCancelsFind bug
  }
  class lg0 breaks
  class lg1 bugPath
  state "At the same time" as all {
    state "Admin" as r0 {
      s0: Admin not linked yet
      s1: Linked, nothing selected
      s2: Linked, Admin field selected
      s3: Finding the block in Admin
      s4: Highlighting the block in Admin
      [*] --> s0
      s0 --> s1: the two sides link [when Preview linked, idle or Preview not linked yet or Preview page loading]
      s1 --> s0: the preview finishes loading
      s1 --> s2: you focus a block field in Admin
      s1 --> s3: the preview reports your click [unless Preview not linked yet]
      s2 --> s0: the preview finishes loading
      s3 --> s1: the block can't be found within 2 s
      s3 --> s2: you focus a block field in Admin
      s3 --> s4: the block shows up
      s2 --> s3: the preview reports your click [unless Preview not linked yet]
      s4 --> s1: the highlight fades after 1.2 s
    }
    --
    state "Preview" as r1 {
      s5: Preview page loading
      s6: Preview not linked yet
      s7: Preview linked, idle
      s8: Finding the block in the preview
      s9: Still finding the Admin block after your click
      s10: Highlighting the block in the preview
      [*] --> s5
      s5 --> s6: the preview page starts
      s6 --> s7: the two sides link [when Linked, nothing selected]
      s7 --> s5: you reload the preview
      s7 --> s8: your Admin pick reaches the preview [unless Admin not linked yet]
      s8 --> s9: you click a block in the preview
      s8 --> s7: the block can't be found within 2 s
      s8 --> s10: the block shows up
      s8 --> s5: you reload the preview
      s9 --> s7: the block can't be found within 2 s
      s9 --> s10: the block shows up
      s10 --> s7: the highlight fades after 1.2 s
      s9 --> s8: your Admin pick reaches the preview [unless Admin not linked yet]
    }
  }
  classDef breaks fill:#ffecee,stroke:#e72e3b,stroke-width:2.5px,color:#cd2834
  class s0 bugPath
  class s1 bugPath
  class s2 bugPath
  class s5 bugPath
  class s6 bugPath
  class s7 bugPath
  class s8 bugPath
  class s9 breaks
  class s9 bugPath
```

## Rules

| Rule                          | In plain words                                                                                                   | Result                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `OneFindPerSide`              | Each side has at most one find pending.                                                                          | Holds                                        |
| `NothingBeforeLink`           | Neither side looks for or highlights a block, or keeps a selection, before it links.                             | Holds                                        |
| `AdminPickCancelsFind`        | Picking a field in Admin cancels any find still pending in Admin.                                                | Holds                                        |
| `PreviewClickCancelsFind`     | Clicking a block in the preview stops the preview looking for an earlier block.                                  | Breaks: a click while the preview is finding |
| `PreviewClickClearsSelection` | After the preview reports a click, Admin forgets its selection, so focusing that field again sends a new locate. | Holds                                        |
| `ReloadClearsSelection`       | After a reload, Admin drops the old selection before the new page links, and no stale find survives the reset.   | Holds                                        |

The chart config uses two blocks, at most one message in flight each way, and block symmetry (484 states). `PreviewLinkingDeep.cfg` allows three messages each way with no symmetry (90,219 states) and gives the same results. Breaking the model one guard at a time made each holding rule fail on its own change, so no rule holds vacuously.

`PreviewClickCancelsFind` breaks on this path:

1. The preview page starts.
2. Admin links.
3. The preview links.
4. You focus a block field in Admin.
5. Your Admin pick reaches the preview before that block renders.
6. You click a different block in the preview.

The `click` handler in `packages/payload-live-preview/src/bridge.ts` sends `locate` but calls neither `work.cancel()` nor `visuals.cancelReveal()`, which the Admin `select` in `src/client.tsx` does. A scratch vitest that drove the real `createPreviewBridge` under jsdom with fake timers reproduced it. The click posted `locate ["clicked"]`, the earlier find stayed pending, and when the Admin block rendered 500 ms later the preview highlighted that block.

## What the model leaves out

- Within a find, the try, the watch, and the 300 ms collapsed-ancestor wait are one finding state.
- A reveal (scroll, the 700 ms `scrollend` fallback, then the flash) is one step. A preview click also fails to cancel a preview scroll already in progress, which the model cannot show.
- The row-header click that always resends, ancestor fallback ids, hover, origin, source, and payload validation, and nested bridge registrations.
- Exit Live Preview and effect reruns on a locale or URL change. They use the same reset as a reload.
- Only two blocks exist, messages to the old page are lost on reload, and only one reload is pending at a time.
- The chart hides the relink resets from every linked state, "the preview finishes loading" from finding or highlighting in Admin, "you reload the preview" from the unlinked, stale, and highlighting preview states, an Admin pick or a reported click while the Admin highlight fades, an Admin pick reaching a highlighting preview, and a preview click from the stale state. It also does not draw the 402 steps that stay inside one chart state, such as dropped messages.

## Regenerate

From [`live-preview-linking/`](live-preview-linking/), with the `scripts/statechart` command of the pstack `statechart` skill:

```sh
statechart PreviewLinking.tla --config PreviewLinking.cfg --view view.mjs --out /tmp/linking-chart
statechart PreviewLinking.tla --config PreviewLinkingDeep.cfg --view view.mjs --out /tmp/linking-deep
```
