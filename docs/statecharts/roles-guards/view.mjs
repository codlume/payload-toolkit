export const title = "payload-roles: who can change a user's or role's access";

const has = (set, item) => Array.isArray(set) && set.includes(item);
const active = (v, who) => v.status[who] === "active";

const superAdmins = (v) => {
  const ana = active(v, "Ana") && v.sa.Ana;
  const ben = active(v, "Ben") && v.sa.Ben;
  if (ana && ben) return "Ana and Ben";
  if (ana) return "Ana only";
  if (ben) return "Ben only";
  return "nobody yet";
};

const member = (v, who) => {
  if (v.status[who] === "absent") return "not signed up";
  if (v.status[who] === "removed") return "removed";
  const roles = v.roles[who];
  if (has(roles, "editor") && has(roles, "manager")) return "editor and manager";
  if (has(roles, "manager")) return "manager";
  if (has(roles, "editor")) return "editor";
  return "no role";
};

export const state = (v) => ({
  "Super admins": superAdmins(v),
  Ben: member(v, "Ben"),
  Cara: member(v, "Cara"),
  "Editor role": has(v.editorGrants, "billing") ? "content and billing" : "content only",
});

const PEOPLE = ["Ana", "Ben", "Cara"];
const changed = (from, to, key) =>
  PEOPLE.find((u) => JSON.stringify(from[key][u]) !== JSON.stringify(to[key][u]));

const roleChange = (from, to) => {
  const who = changed(from, to, "roles");
  const before = from.roles[who];
  const after = to.roles[who];
  const added = after.find((r) => !before.includes(r));
  const removed = before.find((r) => !after.includes(r));
  return added ? `gives ${who} ${added}` : `takes ${removed} from ${who}`;
};

export const step = (action, from, to) => {
  switch (action) {
    case "FirstSignUp":
      return "Ana signs up first";
    case "OthersSignUp":
      return "Ben and Cara sign up [after Ana]";
    case "Promote":
      return changed(from, to, "sa") === "Ben"
        ? "a super admin makes Ben a super admin [after Ben signs up]"
        : "Ben makes Ana a super admin again";
    case "Demote":
      return `a super admin demotes ${changed(from, to, "sa")}`;
    case "SuperAdminRemoves":
      return changed(from, to, "status") === "Cara"
        ? null
        : `a super admin removes ${changed(from, to, "status")}`;
    case "ManagerRemoves":
      if (changed(from, to, "status") === "Ben" || from.roles.Cara.length === 0) return null;
      return from.roles.Cara.includes("manager")
        ? "Cara removes herself, or Ben removes her"
        : "a manager removes Cara";
    case "SuperAdminChangesRoles":
      return changed(from, to, "roles") === "Cara" ? null : `a super admin ${roleChange(from, to)}`;
    case "ManagerChangesRoles":
      return changed(from, to, "roles") === "Ben" ? null : `a manager ${roleChange(from, to)}`;
    case "SuperAdminEditsEditorRole":
      return has(to.editorGrants, "billing")
        ? "a super admin adds billing to the editor role"
        : "a super admin takes billing off the editor role";
    case "ManagerEditsEditorRole":
      return null;
    default:
      return action;
  }
};
