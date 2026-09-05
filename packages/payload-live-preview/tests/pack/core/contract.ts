import { blockMarker, createPreviewBridge } from "@codlume/payload-live-preview/core";

const block = { id: "row-1", blockType: "text", content: "Structural block" };
blockMarker(block, { draft: true });
blockMarker({ id: null, blockType: "text", content: "Unsaved" }, { draft: false });
blockMarker({ blockType: "text" }, { draft: true });
const cleanup: () => void = createPreviewBridge({
  serverURL: "https://cms.example.com",
  debug: true,
});
cleanup();

// @ts-expect-error the draft decision is required
blockMarker(block);
// @ts-expect-error the draft flag is required
blockMarker(block, {});
// @ts-expect-error block types supply the hover label
blockMarker({ id: "row-1" }, { draft: true });
// @ts-expect-error the Admin server URL is required
createPreviewBridge({});
// @ts-expect-error implementation modules are private
import { blockMarker as privateMarker } from "@codlume/payload-live-preview/dist/marker.mjs";
void privateMarker;
