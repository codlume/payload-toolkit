import { expect, test } from "@playwright/test";
import { createE2EPayload } from "./e2e-context.ts";
import { openLinkedPreview, seedLinkedPage } from "./live-preview-context.ts";
import { login } from "./login.ts";

let payload: Awaited<ReturnType<typeof createE2EPayload>>;
let seededPage: Awaited<ReturnType<typeof seedLinkedPage>>;
test.beforeAll(async () => {
  payload = await createE2EPayload("enabled");
});
test.beforeEach(async () => {
  seededPage = await seedLinkedPage(payload);
});
test.afterAll(async () => {
  await payload?.destroy();
});

test("server draft preview links text blocks in both directions without taking focus", async ({
  page,
}) => {
  await login(page);
  const preview = await openLinkedPreview(page, seededPage.id);
  const first = preview.locator(`[data-payload-block="${seededPage.layout![0]!.id}"]`);
  await expect(first).toHaveText("Draft block 1");
  await first.hover();
  await expect(first).toHaveAttribute("data-payload-block-hover", "");
  await first.click();
  const row = page.locator("#layout-row-0 .blocks-field__row");
  await expect(row).toHaveAttribute("data-payload-block-highlight", "");
  await expect(row).not.toHaveAttribute("data-payload-block-highlight", "", { timeout: 3000 });
  const lastField = page.locator("#field-layout__5__content");
  await lastField.focus();
  const last = preview.locator(`[data-payload-block="${seededPage.layout![5]!.id}"]`);
  await expect(last).toBeInViewport();
  await expect(last).toHaveAttribute("data-payload-block-highlight", "");
  await expect(lastField).toBeFocused();
  await expect(last).not.toHaveAttribute("data-payload-block-highlight", "", { timeout: 3000 });
  await lastField.pressSequentially(" extra");
  await expect(lastField).toBeFocused();
  await expect(last).not.toHaveAttribute("data-payload-block-highlight", "");
});

test("public pages omit markers and an unauthenticated preview entry rejects access", async ({
  page,
  request,
}) => {
  await page.goto(`/pages/${seededPage.slug}`);
  await expect(page.getByText("Published block 1", { exact: true })).toBeVisible();
  await expect(page.locator("[data-payload-block]")).toHaveCount(0);
  expect((await request.get(`/preview?slug=${seededPage.slug}`)).status()).toBe(401);
});

test("standalone authenticated drafts stay inert and draft cookies alone cannot read drafts", async ({
  page,
  browser,
}) => {
  await login(page);
  await page.goto(`/preview?slug=${seededPage.slug}`);
  await expect(page.locator("[data-payload-block]").first()).toHaveText("Draft block 1");
  await expect(page.locator("html")).not.toHaveAttribute("data-payload-linking", "");
  const anonymous = await browser.newContext();
  try {
    await anonymous.addCookies(
      (await page.context().cookies()).filter((cookie) => cookie.name.startsWith("__prerender")),
    );
    const other = await anonymous.newPage();
    await other.goto(new URL(`/pages/${seededPage.slug}`, page.url()).href);
    await expect(other.getByText("Published block 1", { exact: true })).toBeVisible();
    await expect(other.locator("[data-payload-block]")).toHaveCount(0);
  } finally {
    await anonymous.close();
  }
});

test("row-header repeats, collapsed rows and native actions keep working", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    Reflect.set(window, "pluginLocates", 0);
    window.addEventListener("message", (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (
        typeof data === "object" &&
        data !== null &&
        "type" in data &&
        data.type === "@codlume/payload-live-preview" &&
        "event" in data &&
        data.event === "locate"
      ) {
        Reflect.set(window, "pluginLocates", Number(Reflect.get(window, "pluginLocates")) + 1);
      }
    });
  });
  await login(page);
  const preview = await openLinkedPreview(page, seededPage.id);
  const first = preview.locator(`[data-payload-block="${seededPage.layout![0]!.id}"]`);
  const count = () =>
    preview.locator("html").evaluate(() => Number(Reflect.get(window, "pluginLocates")));
  const header = page.locator("#layout-row-0 .collapsible__header");
  await header.click();
  await expect.poll(count).toBeGreaterThan(0);
  const afterHeader = await count();
  await header.click();
  await expect.poll(count).toBe(afterHeader + 1);
  const field = page.locator("#field-layout__0__content");
  await field.focus();
  await field.click();
  expect(await count()).toBe(afterHeader + 1);
  await first.hover();
  await page.screenshot({ path: testInfo.outputPath("hover.png") });
  const scroll = await first.evaluate(() => window.scrollY);
  await header.click();
  await expect(field).not.toBeVisible();
  await first.click();
  await expect(field).toBeVisible();
  await expect(page.locator("#layout-row-0 .blocks-field__row")).toHaveAttribute(
    "data-payload-block-highlight",
    "",
  );
  expect(await first.evaluate(() => window.scrollY)).toBe(scroll);
  await first.evaluate((element) => {
    const link = document.createElement("a");
    link.href = "#native-action";
    link.textContent = "Normal link";
    const button = document.createElement("button");
    button.textContent = "Normal button";
    button.addEventListener("click", () => {
      button.textContent = "Button worked";
    });
    element.append(link, button);
  });
  await first.getByRole("link", { name: "Normal link" }).click();
  expect(await first.evaluate(() => window.location.hash)).toBe("#native-action");
  await first.getByRole("button", { name: "Normal button" }).click();
  await expect(first.getByRole("button", { name: "Button worked" })).toBeFocused();
  await preview.locator("h1").hover();
  await expect(first).not.toHaveAttribute("data-payload-block-hover", "");
  await expect(first).not.toHaveAttribute("data-payload-block-highlight", "", { timeout: 3000 });
  expect(await first.evaluate((element) => element.style.position)).toBe("");
});
