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
      // oxlint-disable-next-line oxc/no-map-spread -- retain the original published fixture
      layout: (published.layout ?? []).map((block, index) => ({
        ...block,
        content: `Draft block ${index + 1}`,
      })),
    },
  });
};

export const openLinkedPreview = async (page: Page, id: number) => {
  await page.goto(`/admin/collections/pages/${id}`);
  await expect(
    page.getByRole("button", { name: /^(Live Preview|Exit Live Preview)$/ }),
  ).toBeVisible();
  const open = page.getByRole("button", { name: "Live Preview", exact: true });
  if (await open.isVisible()) await open.click();
  const preview = page.frameLocator("iframe");
  await expect(preview.locator("html")).toHaveAttribute("data-payload-linking", "");
  return preview;
};
