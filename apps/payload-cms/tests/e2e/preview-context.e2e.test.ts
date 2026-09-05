import { expect, test } from "@playwright/test";
import { createE2EPayload, seedAdminUser } from "./e2e-context.ts";
import { login } from "./login.ts";
import type { PreviewGlobalData } from "../fixtures/preview-global.tsx";

let payload: Awaited<ReturnType<typeof createE2EPayload>>;
test.beforeAll(async () => {
  payload = await createE2EPayload("enabled");
});
test.afterAll(async () => {
  await payload?.destroy();
});

for (const mode of ["server", "client"]) {
  test(`${mode} global linking cancels stale locale work and renews selection`, async ({
    page,
  }) => {
    const user = await seedAdminUser(payload);
    const englishData = {
      siteName: "English global",
      previewMode: mode,
      layout: [{ blockType: "text" as const, content: "English block" }],
    };
    const english: PreviewGlobalData = await payload.updateGlobal({
      slug: "site-settings",
      // @ts-expect-error -- Locales exist only in the opt-in test schema.
      locale: "en",
      user,
      data: englishData,
    });
    const polishData = {
      siteName: "Polish global",
      previewMode: mode,
      layout: [
        { blockType: "text" as const, content: "Polish block" },
        { blockType: "text" as const, content: "Only in Polish" },
      ],
    };
    const polish: PreviewGlobalData = await payload.updateGlobal({
      slug: "site-settings",
      // @ts-expect-error -- Locales exist only in the opt-in test schema.
      locale: "pl",
      user,
      data: polishData,
    });
    const englishID = english.layout![0]!.id!;
    const pendingID = polish.layout![1]!.id!;
    const events: string[] = [];
    page.on("console", (message) => {
      if (message.text().startsWith("[@codlume/payload-live-preview:")) events.push(message.text());
    });
    await login(page);
    await page.goto("/admin/globals/site-settings?locale=en");
    const open = page.getByRole("button", { name: "Live Preview", exact: true });
    if (await open.isVisible()) await open.click();
    const preview = page.frameLocator("iframe");
    await expect(preview.locator("html")).toHaveAttribute("data-payload-linking", "", {
      timeout: 15000,
    });
    await expect(preview.locator("h1")).toHaveText("English global");
    expect(
      await preview.locator("html").evaluate(() => new URL(location.href).searchParams.get("mode")),
    ).toBe(mode);
    const target = preview.locator(`[data-payload-block="${englishID}"]`);
    await target.click();
    const row = page.locator("#layout-row-0 .blocks-field__row");
    await expect(row).toHaveAttribute("data-payload-block-highlight", "");
    const field = page.locator("#field-layout__0__content");
    await field.focus();
    await expect(target).toHaveAttribute("data-payload-block-highlight", "");
    await expect(field).toBeFocused();
    const originalURL = await preview.locator("html").evaluate(() => location.href);

    // Wait for an English-locale request whose row exists only in Polish.
    await preview.locator("html").evaluate(
      (_element, id) =>
        window.parent.postMessage(
          {
            type: "@codlume/payload-live-preview",
            event: "locate",
            ids: [id],
          },
          location.origin,
        ),
      pendingID,
    );
    await expect
      .poll(() =>
        events.some(
          (event) => event.includes("admin] missing target") && event.includes(pendingID),
        ),
      )
      .toBe(true);
    await page.locator("iframe").evaluate((iframe, id) => {
      if (!(iframe instanceof HTMLIFrameElement)) throw new Error("Missing preview iframe");
      iframe.contentWindow!.postMessage(
        {
          type: "@codlume/payload-live-preview",
          event: "locate",
          ids: [id],
        },
        location.origin,
      );
    }, pendingID);
    await expect
      .poll(() =>
        events.some(
          (event) => event.includes("preview] missing target") && event.includes(pendingID),
        ),
      )
      .toBe(true);
    const previousResets = events.filter((event) => event.endsWith("admin] reset")).length;
    await page.getByRole("button", { name: "Locale", exact: true }).click();
    await page.getByRole("button", { name: /Polish/ }).click();
    await expect(field).toHaveValue("Polish block");
    await expect
      .poll(() => events.filter((event) => event.endsWith("admin] reset")).length)
      .toBeGreaterThan(previousResets);
    await expect(preview.locator("h1")).toHaveText("Polish global");
    await expect(preview.locator("html")).toHaveAttribute("data-payload-linking", "");
    if (mode === "client")
      expect(await preview.locator("html").evaluate(() => location.href)).toBe(originalURL);
    await expect(preview.locator(`[data-payload-block="${pendingID}"]`)).not.toHaveAttribute(
      "data-payload-block-highlight",
      "",
    );
    await expect(page.locator("#layout-row-1 .blocks-field__row")).not.toHaveAttribute(
      "data-payload-block-highlight",
      "",
    );
    const sent = () => events.filter((event) => event.includes("admin] sent locate")).length;
    const beforeSelection = sent();
    await field.focus();
    await expect.poll(sent).toBe(beforeSelection + 1);
    const translated = preview.locator(`[data-payload-block="${polish.layout![0]!.id}"]`);
    await expect(translated).toHaveText("Polish block");
    await expect(translated).toHaveAttribute("data-payload-block-highlight", "");
    // A fresh unavailable request expiring proves the old request's whole wait has passed.
    await preview.locator("html").evaluate(() =>
      window.parent.postMessage(
        {
          type: "@codlume/payload-live-preview",
          event: "locate",
          ids: ["polish-timeout"],
        },
        location.origin,
      ),
    );
    await expect
      .poll(() =>
        events.some(
          (event) => event.includes("target timeout") && event.includes("polish-timeout"),
        ),
      )
      .toBe(true);
    expect(
      events.some((event) => event.includes("target timeout") && event.includes(pendingID)),
    ).toBe(false);
    await preview.locator(`[data-payload-block="${pendingID}"]`).click();
    await expect(page.locator("#layout-row-1 .blocks-field__row")).toHaveAttribute(
      "data-payload-block-highlight",
      "",
    );
  });
}

test("a conditional global URL stays unavailable until the document enables it", async ({
  page,
}) => {
  const user = await seedAdminUser(payload);
  await payload.updateGlobal({
    slug: "site-settings",
    // @ts-expect-error -- Locales exist only in the opt-in test schema.
    locale: "en",
    user,
    data: { siteName: "" },
  });
  await login(page);
  await page.goto("/admin/globals/site-settings?locale=en");
  await expect(page.locator("#field-siteName")).toHaveValue("");
  await expect(page.locator("html")).not.toHaveAttribute("data-payload-linking", "");
  await expect(page.getByRole("button", { name: "Live Preview", exact: true })).toHaveCount(0);
  await page.locator("#field-siteName").fill("Available global");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Live Preview", exact: true }).click();
  await expect(page.frameLocator("iframe").locator("h1")).toHaveText("Available global");
  await expect(page.locator("html")).toHaveAttribute("data-payload-linking", "");
});
