import { expect, test } from "@playwright/test";

import { createE2EPayload, seedAdminUser } from "./e2e-context.ts";
import { login } from "./login.ts";

let payload: Awaited<ReturnType<typeof createE2EPayload>>;

test.beforeAll(async () => {
  payload = await createE2EPayload("disabled");
  await seedAdminUser(payload);
});

test.afterAll(async () => {
  await payload.db.destroy?.();
});

test("disabled configuration hides the Admin preview", async ({ page }) => {
  await login(page);
  await page.goto("/admin/collections/media/create");

  await expect(page.locator("[data-blurhash-panel]")).toHaveCount(0);
  await expect(page.getByLabel("Read-only value")).toHaveCount(0);
});
