const admin = (v) => {
  if (!v.aLinked) return "Admin not linked yet";
  if (v.aFind.length) return "Finding the block in Admin";
  if (v.aLit !== "none") return "Highlighting the block in Admin";
  if (v.aSel !== "none") return "Linked, Admin field selected";
  return "Linked, nothing selected";
};

const preview = (v) => {
  if (v.pPhase === "loading") return "Preview page loading";
  if (v.pPhase === "waiting") return "Preview not linked yet";
  if (v.pFind.length)
    return v.pFindStale
      ? "Still finding the Admin block after your click"
      : "Finding the block in the preview";
  if (v.pLit !== "none") return "Highlighting the block in the preview";
  return "Preview linked, idle";
};

export const title = "Live Preview linking: Admin form and preview iframe";

export const state = (v) => ({ Admin: admin(v), Preview: preview(v) });

const isDuplicateArrow = (action, from) => {
  const a = admin(from);
  const p = preview(from);
  const fading = a === "Highlighting the block in Admin";
  switch (action) {
    case "AdminGetsReady":
    case "AdminGetsAck":
      return from.aLinked;
    case "PreviewGetsReady":
    case "PreviewGetsAck":
      return from.pPhase === "linked";
    case "AdminSeesLoad":
      return a === "Finding the block in Admin" || fading;
    case "YouReloadPreview":
      return p !== "Preview linked, idle" && p !== "Finding the block in the preview";
    case "YouFocusAdminField":
    case "AdminGetsLocate":
      return fading;
    case "PreviewGetsLocate":
      return p === "Highlighting the block in the preview";
  }
  return false;
};

export const step = (action, from) => {
  if (isDuplicateArrow(action, from)) return null;
  switch (action) {
    case "PreviewPageStarts":
      return "the preview page starts";
    case "AdminSeesLoad":
      return "the preview finishes loading";
    case "YouReloadPreview":
      return "you reload the preview";
    case "AdminGetsReady":
    case "AdminGetsAck":
      return from.aLinked ? "the preview links again" : "the two sides link";
    case "PreviewGetsReady":
    case "PreviewGetsAck":
      return from.pPhase === "linked" ? "Admin links again" : "the two sides link";
    case "AdminGetsLocate":
      return "the preview reports your click";
    case "PreviewGetsLocate":
      return "your Admin pick reaches the preview";
    case "YouFocusAdminField":
      return "you focus a block field in Admin";
    case "YouClickPreviewBlock":
      return "you click a block in the preview";
    case "AdminFindsBlock":
    case "PreviewFindsBlock":
      return "the block shows up";
    case "AdminGivesUp":
    case "PreviewGivesUp":
      return "the block can't be found within 2 s";
    case "AdminHighlightFades":
    case "PreviewHighlightFades":
      return "the highlight fades after 1.2 s";
  }
  return action;
};
