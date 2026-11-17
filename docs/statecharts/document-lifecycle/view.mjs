const ORDER = ["create", "readVersions", "update", "trash", "publish", "unpublish", "delete"];

const VERBS = {
  CreateDraft: "an editor creates it as a draft",
  CreatePublished: "an editor creates it published",
  SaveDraft: "an editor saves a draft",
  Publish: "an editor publishes",
  SaveWithoutDraftMode: "an API save outside draft mode takes the newer draft's status",
  Unpublish: "an editor clicks Unpublish",
  MoveToTrash: "someone moves it to trash",
  RestoreFromTrashAsDraft: "someone restores it from trash as a draft",
  RestoreFromTrashAsPublished: "someone restores it from trash as published",
  DeleteForGood: "someone deletes it for good",
  RestorePublishedVersion: "an editor restores an earlier published version",
  RestoreDraftVersion: "an editor restores a draft version",
  RestoreVersionAsDraft: "an editor restores a version as a draft",
};

const asList = (set) => (Array.isArray(set) ? set : Object.values(set ?? {}));

export const title = "A Pages document under payload-roles: each move and the grants it needs";

export const state = (v) => {
  const d = v.doc;
  if (d.stage === "absent") return "Not created yet";
  if (d.stage === "gone") return "Deleted for good";
  if (d.trashed) return "In trash, off the site";
  if (d.published && d.pending) return "Live, with unpublished draft changes";
  if (d.published) return "Live, visitors see it";
  return "Draft only, off the site";
};

export const group = (v) => {
  const d = v.doc;
  if (d.stage !== "exists") return "gone";
  if (d.trashed) return "trash";
  return d.published ? "live" : "draft";
};

export const colors = { live: "teal", draft: "blue", trash: "orange", gone: "tan" };

export const step = (action, from, to) => {
  if (action === "RoleChanges") return "an admin changes the editor's role";
  if (action === "Done" || !to.lastAttempt.ok) return null;
  const needs = asList(to.lastAttempt.needs);
  const held = ORDER.filter((a) => needs.includes(a));
  return `${VERBS[action] ?? action} [needs ${held.join(" + ")}]`;
};
