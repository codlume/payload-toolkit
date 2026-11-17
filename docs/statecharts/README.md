# Statecharts

Each chart here is drawn from a TLA+ model that TLC checked. The model's rules are the behavior a reviewer agreed to, and the chart marks any state that breaks one. Read the chart before you change its flow. When a rule changes, update the model and draw the chart again in the same pull request.

| Flow                                                           | What it covers                                                                                                    | Result                                                                                    |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [Document lifecycle](document-lifecycle.md)                    | Drafts, publishing, unpublishing, trash, restore, and delete under payload-roles, with the grants each move needs | All rules hold                                                                            |
| [Roles escalation guards](roles-guards.md)                     | Who can promote, demote, and remove users, and give, take, and edit roles                                         | One candidate rule breaks: a manager can take a role they fully hold from a stronger user |
| [Live preview linking](live-preview-linking.md)                | The Admin form and the preview iframe connecting, picking blocks on either side, and reloading                    | All rules hold                                                                            |
| [Media placeholder and Last Modified By](media-placeholder.md) | BlurHash placeholders and activity attribution across uploads, removals, and restores                             | All rules hold                                                                            |

Each model lives in the folder named after its chart, with the spec, its config, and the `view.mjs` that names the states. Draw a chart again with the `scripts/statechart` command of the pstack `statechart` skill. Each chart file gives the exact command.
