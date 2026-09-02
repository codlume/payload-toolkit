import type { Payload } from "payload";

import type { Page } from "../payload-types.generated.ts";

// PROTOTYPE — throwaway. Seeds an admin user and one page with blocks three levels
// deep, tall enough that locate has to scroll and expand. Runs on init when
// PAYLOAD_LP_PROTOTYPE is set; idempotent.

export const prototypeUser = {
  email: "preview@example.com",
  name: "Preview Admin",
  password: "preview-test-password",
};

const lorem =
  "Wayfinding is about finding the way, not charging at the destination. The map is deliberately incomplete: beyond the live tickets lies the fog of war, the dim view of decisions you can tell are coming but cannot yet pin down.\n\nResolving a ticket clears the fog ahead of it, graduating whatever is now specifiable into fresh tickets, one at a time, until the way to the destination is clear.";

const text = (body: string) => ({ blockType: "text" as const, body });
const quote = (q: string, author: string) => ({ blockType: "quote" as const, quote: q, author });
const hero = (heading: string, t: string) => ({ blockType: "hero" as const, heading, text: t });
type Layout = NonNullable<Page["layout"]>[number];
type Content = NonNullable<
  NonNullable<Extract<Layout, { blockType: "columns" }>["columns"]>[number]["content"]
>[number];

const columns = (...cols: Content[][]): Layout => ({
  blockType: "columns" as const,
  columns: cols.map((content) => ({ blockType: "column" as const, content })),
});

export const seedLivePreviewPrototype = async (payload: Payload) => {
  const users = await payload.find({
    collection: "users",
    limit: 1,
    where: { email: { equals: prototypeUser.email } },
  });
  if (users.docs.length === 0) await payload.create({ collection: "users", data: prototypeUser });

  const pages = await payload.find({
    collection: "pages",
    limit: 1,
    where: { slug: { equals: "prototype" } },
  });
  if (pages.docs.length > 0) {
    payload.logger.info(`[lp-proto] page ready: /admin/collections/pages/${pages.docs[0]?.id}`);
    return;
  }

  const page = await payload.create({
    collection: "pages",
    data: {
      title: "Linking prototype",
      slug: "prototype",
      _status: "published",
      layout: [
        hero(
          "Live Preview linking",
          "Hover a block, click it, watch the admin. Click a row in the admin, watch the preview.",
        ),
        text(lorem),
        columns(
          [
            text("First column, first block."),
            quote(
              "Fight for the smallest model that makes the correct behavior unsurprising.",
              "AGENTS.md",
            ),
          ],
          [
            hero("Nested hero", "Three levels deep: layout → columns → column → content."),
            text("First column, third block."),
          ],
        ),
        text(lorem),
        quote("Measure twice, cut once.", "Everyone's grandparent"),
        text(lorem),
        text(lorem),
        columns(
          [
            text("Far down the page, so the admin has to scroll and expand to reach it."),
            text(lorem),
          ],
          [
            quote("Complexity belongs at the adapter boundary.", "Taste"),
            text("Second column, second block."),
          ],
          [text("Third column.")],
        ),
        text(lorem),
        hero("The end", "Nothing below this."),
      ],
    },
  });
  payload.logger.info(`[lp-proto] seeded page: /admin/collections/pages/${page.id}`);
};
