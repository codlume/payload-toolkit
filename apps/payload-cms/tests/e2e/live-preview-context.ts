import { expect, type Page } from "@playwright/test";
import { createE2EPayload, seedAdminUser } from "./e2e-context.ts";

export const seedLinkedPage = async (payload: Awaited<ReturnType<typeof createE2EPayload>>) => {
  const admin = await seedAdminUser(payload);
  const published = await payload.create({
    collection: "pages",
    user: admin,
    data: {
      title: "Linked page",
      slug: `linked-${crypto.randomUUID()}`,
      _status: "published",
      layout: Array.from({ length: 6 }, (_, index) => ({
        blockType: "text" as const,
        content: `Published block ${index + 1}`,
      })),
    },
  });
  return payload.update({
    collection: "pages",
    id: published.id,
    draft: true,
    user: admin,
    data: {
      layout: (published.layout ?? [])
        .filter((block) => block.blockType === "text")
        // oxlint-disable-next-line oxc/no-map-spread -- retain the original published fixture
        .map((block, index) => ({
          ...block,
          content: `Draft block ${index + 1}`,
        })),
    },
  });
};

export const openLinkedPreview = async (page: Page, id: number, route = "/pages/") => {
  await page.goto(`/admin/collections/pages/${id}`);
  await expect(
    page.getByRole("button", { name: /^(Live Preview|Exit Live Preview)$/ }),
  ).toBeVisible();
  const open = page.getByRole("button", { name: "Live Preview", exact: true });
  if (await open.isVisible()) await open.click();
  const preview = page.frameLocator("iframe");
  await expect(preview.locator("html")).toHaveAttribute("data-payload-linking", "", {
    timeout: 15000,
  });
  const path = await preview.locator("html").evaluate(() => window.location.pathname);
  if (!path.startsWith(route)) {
    await preview
      .locator("html")
      .evaluate(
        (_element, next) => window.location.replace(next),
        `${route}${path.split("/").at(-1)}`,
      );
    await expect
      .poll(() => preview.locator("html").evaluate(() => window.location.pathname))
      .toContain(route);
    await expect(preview.locator("html")).toHaveAttribute("data-payload-linking", "", {
      timeout: 15000,
    });
  }
  return preview;
};

/** Each test owns a fresh document; Payload supplies every row identity. */
export const seedNestedPage = async (payload: Awaited<ReturnType<typeof createE2EPayload>>) => {
  const admin = await seedAdminUser(payload);
  return payload.create({
    collection: "pages",
    user: admin,
    data: {
      title: "Nested page",
      slug: `nested-${crypto.randomUUID()}`,
      _status: "published",
      layout: [
        ...Array.from({ length: 6 }, (_, index) => ({
          blockType: "text" as const,
          content: `Sibling ${index + 1}`,
        })),
        {
          blockType: "section",
          heading: "Outer section",
          content: [
            {
              blockType: "section",
              heading: "Inner section",
              content: [{ blockType: "text", content: "Deep target" }],
            },
          ],
        },
      ],
    },
  });
};

// Add future preview routes here so they inherit the same nested-linking scenarios.
export const previewRoutes = ["/pages/"];
