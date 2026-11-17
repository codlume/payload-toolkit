export const title = "Media placeholder and Last Modified By";

export const state = (v) => ({
  Placeholder:
    v.placeholder === "forged"
      ? "Placeholder written by a caller"
      : v.placeholder !== "none" && v.placeholder !== v.image
        ? "Placeholder from an older image"
        : v.restored && v.placeholder !== "red"
          ? "Restored image, its placeholder lost"
          : v.placeholder === "none"
            ? "No placeholder"
            : "Placeholder from current image",
  "Last modified by":
    v.lastModifiedBy === "ana"
      ? "Last modified by Ana"
      : v.lastModifiedBy === "forged"
        ? "Name written by a caller"
        : "Nobody recorded",
  BlurHash: v.blurHashOn ? "On" : "Off",
});

const labels = {
  AnaUploadsImage: "Ana uploads a different image",
  AnaEditsMetadata: null,
  ScriptEditsMetadata:
    "a script edits the metadata without a user, sending its own placeholder and name",
  AnaRemovesFile: "Ana removes the file",
  AnaRestoresVersion: "Ana restores the older version in the admin",
  ScriptRestoresVersion: "a server script restores the older version",
  TurnBlurHashOff: "the maintainer turns BlurHash off",
  TurnBlurHashOn: "the maintainer turns BlurHash on",
};

export const step = (action) => labels[action];
