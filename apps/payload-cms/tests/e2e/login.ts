import { expect, type Page } from "@playwright/test";

import { adminUser } from "./e2e-context.ts";

export const login = async (page: Page) => {
  await page.goto("/admin/login");
  await page.locator("#field-email").fill(adminUser.email);
  await page.locator("#field-password").fill(adminUser.password);
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page).toHaveURL(/\/admin$/);
};
