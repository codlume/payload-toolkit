import { expect, test } from "@playwright/test";
import { createE2EPayload } from "./e2e-context.ts";
import {
  openLinkedPreview,
  seedLinkedPage,
  seedNestedPage,
  previewRoutes,
} from "./live-preview-context.ts";
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

for (const route of previewRoutes) {
  test(`${route} draft preview links text blocks in both directions without taking focus`, async ({
    page,
  }) => {
    await login(page);
    const preview = await openLinkedPreview(page, seededPage.id, route);
    const first = preview.locator(`[data-payload-block="${seededPage.layout![0]!.id}"]`);
    await expect(first).toHaveText("Draft block 1");
    // Enter the block after connection even if navigation left the pointer over it.
    await preview.locator("h1").hover();
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

  test(`${route} public pages omit markers and an unauthenticated preview entry rejects access`, async ({
    page,
    request,
  }) => {
    await page.goto(`${route}${seededPage.slug}`);
    await expect(page.getByText("Published block 1", { exact: true })).toBeVisible();
    await expect(page.locator("[data-payload-block]")).toHaveCount(0);
    expect(
      (
        await request.get(
          `/preview?slug=${seededPage.slug}&mode=${route === "/pages-client/" ? "client" : "server"}`,
        )
      ).status(),
    ).toBe(401);
  });

  test(`${route} standalone authenticated drafts stay inert and draft cookies alone cannot read drafts`, async ({
    page,
    browser,
  }) => {
    await login(page);
    const unpublished = await payload.create({
      collection: "pages",
      draft: true,
      data: {
        title: "Unpublished",
        slug: `unpublished-${crypto.randomUUID()}`,
        _status: "draft",
        layout: [],
      },
    });
    expect((await page.goto(`${route}${unpublished.slug}`))?.status()).toBe(404);
    await page.goto(
      `/preview?slug=${seededPage.slug}&mode=${route === "/pages-client/" ? "client" : "server"}`,
    );
    await expect(page.locator("[data-payload-block]").first()).toHaveText("Draft block 1");
    await expect(page.locator("html")).not.toHaveAttribute("data-payload-linking", "");
    const anonymous = await browser.newContext();
    try {
      await anonymous.addCookies(
        (await page.context().cookies()).filter((cookie) => cookie.name.startsWith("__prerender")),
      );
      const other = await anonymous.newPage();
      await other.goto(new URL(`${route}${seededPage.slug}`, page.url()).href);
      await expect(other.getByText("Published block 1", { exact: true })).toBeVisible();
      await expect(other.locator("[data-payload-block]")).toHaveCount(0);
    } finally {
      await anonymous.close();
    }
  });

  test(`${route} row-header repeats, collapsed rows and native actions keep working`, async ({
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
    const preview = await openLinkedPreview(page, seededPage.id, route);
    const first = preview.locator(`[data-payload-block="${seededPage.layout![0]!.id}"]`);
    const count = () =>
      preview.locator("html").evaluate(() => Number(Reflect.get(window, "pluginLocates")));
    const header = page
      .locator("#layout-row-0")
      .getByRole("button", { name: "Toggle block", exact: true });
    await header.click();
    await expect.poll(count).toBe(1);
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

  test(`${route} native updates preserve linking through autosave, draft save and publish`, async ({
    page,
  }) => {
    await login(page);
    const preview = await openLinkedPreview(page, seededPage.id, route);
    const first = preview.locator(`[data-payload-block="${seededPage.layout![0]!.id}"]`);
    const field = page.locator("#field-layout__0__content");
    const { promise: saveGate, resolve: releaseSave } = Promise.withResolvers<void>();
    let saving = false;
    await page.route("**/api/pages/**", async (request) => {
      if (
        request.request().method() === "PATCH" &&
        new URL(request.request().url()).searchParams.get("autosave") === "true"
      ) {
        saving = true;
        await saveGate;
      }
      await request.continue();
    });
    try {
      await field.fill("Waiting for autosave");
      await expect.poll(() => saving).toBe(true);
      await expect(first).toHaveText(
        route === "/pages-client/" ? "Waiting for autosave" : "Draft block 1",
      );
    } finally {
      releaseSave();
    }
    await expect(first).toHaveText("Waiting for autosave");
    await page.unroute("**/api/pages/**");
    await field.fill("Manually saved draft");
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response.url().includes(`/api/pages/${seededPage.id}?`) &&
        new URL(response.url()).searchParams.get("draft") === "true" &&
        !new URL(response.url()).searchParams.has("autosave"),
    );
    await page.getByRole("button", { name: "Save Draft", exact: true }).click();
    expect((await saved).ok()).toBe(true);
    await expect(first).toHaveText("Manually saved draft");
    await first.click();
    await expect(page.locator("#layout-row-0 .blocks-field__row")).toHaveAttribute(
      "data-payload-block-highlight",
      "",
    );
    await field.fill("Published from Admin");
    await page.getByRole("button", { name: "Publish changes", exact: true }).click();
    await expect(first).toHaveText("Published from Admin");
    await expect
      .poll(async () => {
        const published = await payload.findByID({ collection: "pages", id: seededPage.id });
        return published.layout?.[0]?.blockType === "text"
          ? published.layout[0].content
          : undefined;
      })
      .toBe("Published from Admin");
    await first.click();
    await expect(page.locator("#layout-row-0 .blocks-field__row")).toHaveAttribute(
      "data-payload-block-highlight",
      "",
    );
  });

  test(`${route} new blocks become linkable when native preview renders them`, async ({ page }) => {
    await login(page);
    const preview = await openLinkedPreview(page, seededPage.id, route);
    const { promise: saveGate, resolve: releaseSave } = Promise.withResolvers<void>();
    await page.route("**/api/pages/**", async (request) => {
      if (request.request().method() === "PATCH") await saveGate;
      await request.continue();
    });
    try {
      await page.getByRole("button", { name: "Add Layout", exact: true }).click();
      await page.getByRole("button", { name: "Text", exact: true }).click();
      const field = page.locator("#field-layout__6__content");
      await field.fill("New linked text");
      if (route === "/pages-client/") {
        await expect(preview.getByText("New linked text", { exact: true })).toBeVisible();
        await preview.getByText("New linked text", { exact: true }).click();
        await expect(page.locator("#layout-row-6 .blocks-field__row")).toHaveAttribute(
          "data-payload-block-highlight",
          "",
        );
      } else {
        await expect(preview.getByText("New linked text", { exact: true })).toHaveCount(0);
      }
    } finally {
      releaseSave();
    }
    const target = preview.getByText("New linked text", { exact: true });
    await expect(target).toBeVisible();
    await target.click();
    await expect(page.locator("#layout-row-6 .blocks-field__row")).toHaveAttribute(
      "data-payload-block-highlight",
      "",
    );
    await expect
      .poll(async () => {
        const saved = await payload.findByID({
          collection: "pages",
          id: seededPage.id,
          draft: true,
        });
        return saved.layout?.[6]?.id;
      })
      .toBe(await target.getAttribute("data-payload-block"));
  });

  test(`${route} reload and close/reopen recover without duplicate or stale locates`, async ({
    page,
  }) => {
    const events: string[] = [];
    page.on("console", (message) => {
      if (message.text().startsWith("[@codlume/payload-live-preview:")) events.push(message.text());
    });
    await login(page);
    let preview = await openLinkedPreview(page, seededPage.id, route);
    const field = page.locator("#field-layout__0__content");
    await field.focus();
    const sent = () =>
      events.filter((event) =>
        event.startsWith("[@codlume/payload-live-preview:admin] sent locate"),
      ).length;
    await expect.poll(sent).toBe(1);
    await field.fill("");
    await field.pressSequentially("Typed content");
    await expect(preview.locator(`[data-payload-block="${seededPage.layout![0]!.id}"]`)).toHaveText(
      "Typed content",
    );
    expect(sent()).toBe(1);
    const connections = () =>
      events.filter((event) => event === "[@codlume/payload-live-preview:admin] connected").length;
    const previous = connections();
    await preview.locator("html").evaluate(() => window.location.reload());
    await expect.poll(connections).toBeGreaterThan(previous);
    await expect(preview.locator("html")).toHaveAttribute("data-payload-linking", "");
    await field.dispatchEvent("focusin");
    await expect.poll(sent).toBe(2);
    const first = preview.locator(`[data-payload-block="${seededPage.layout![0]!.id}"]`);
    await expect(first).toHaveAttribute("data-payload-block-highlight", "");
    await preview
      .locator("html")
      .evaluate(() =>
        window.parent.postMessage(
          { type: "@codlume/payload-live-preview", event: "locate", ids: ["pending-before-close"] },
          window.location.origin,
        ),
      );
    await expect
      .poll(() =>
        events.some(
          (event) => event.includes("missing target") && event.includes("pending-before-close"),
        ),
      )
      .toBe(true);
    await page.getByRole("button", { name: "Exit Live Preview", exact: true }).click();
    await expect(page.locator("html")).not.toHaveAttribute("data-payload-linking", "");
    const beforeReopen = sent();
    preview = await openLinkedPreview(page, seededPage.id, route);
    await field.focus();
    await expect.poll(sent).toBe(beforeReopen + 1);
    await expect(
      preview.locator(`[data-payload-block="${seededPage.layout![0]!.id}"]`),
    ).toHaveAttribute("data-payload-block-highlight", "");
    expect(
      events.filter(
        (event) => event.includes("target timeout") && event.includes("pending-before-close"),
      ),
    ).toEqual([]);
  });

  test(`${route} reveals three depths through collapsed ancestors and preserves nested identity`, async ({
    page,
  }) => {
    const nested = await seedNestedPage(payload);
    const outer = nested.layout![6]!;
    if (outer.blockType !== "section") throw new Error("Missing outer section");
    const inner = outer.content![0]!;
    if (inner.blockType !== "section") throw new Error("Missing inner section");
    const deep = inner.content![0]!;
    await login(page);
    const key = `collection-pages-${nested.id}`;
    expect(
      (
        await page.request.post(`/api/payload-preferences/${key}`, {
          data: {
            value: {
              fields: {
                layout: { collapsed: [outer.id] },
                "layout.6.content": { collapsed: [inner.id] },
              },
            },
          },
        })
      ).ok(),
    ).toBe(true);
    const preview = await openLinkedPreview(page, nested.id, route);
    await expect(preview.locator("body")).toContainText("Deep target");
    const field = page.locator("#field-layout__6__content__0__content__0__content");
    await expect(field).not.toBeVisible();
    // The second locate replaces the first while its collapsed ancestors are opening.
    await preview.locator("html").evaluate(
      (_element, requests) => {
        for (const ids of requests)
          window.parent.postMessage(
            {
              type: "@codlume/payload-live-preview",
              event: "locate",
              ids,
            },
            window.location.origin,
          );
      },
      [[deep.id, inner.id, outer.id], [nested.layout![0]!.id]],
    );
    const siblingRow = page.locator("#layout-row-0 > .blocks-field__row");
    await expect(siblingRow).toHaveAttribute("data-payload-block-highlight", "");
    await expect(siblingRow).not.toHaveAttribute("data-payload-block-highlight", "", {
      timeout: 3000,
    });
    await expect(field).not.toBeVisible();
    const target = preview.locator(`[data-payload-block="${deep.id}"]`);
    await expect(target).toHaveClass("page-text");
    await target.hover();
    await expect(preview.locator("[data-payload-block-hover]")).toHaveCount(1);
    await expect(target).toHaveAttribute("data-payload-block-hover", "");
    await target.click();
    await expect(field).toBeVisible();
    await expect(field).toBeInViewport();
    const row = page.locator("#layout-6-content-0-content-row-0 > .blocks-field__row");
    await expect(row).toHaveAttribute("data-payload-block-highlight", "");
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/payload-preferences/${key}`)).json()).value.fields,
      )
      .toMatchObject({
        layout: { collapsed: [] },
        "layout.6.content": { collapsed: [] },
      });
    await field.focus();
    await expect(target).toHaveAttribute("data-payload-block-highlight", "");
    await expect(field).toBeFocused();
    // An unsaved or removed inner rendering falls back to its real enclosing block.
    await target.evaluate((element) => element.removeAttribute("data-payload-block"));
    await page
      .locator("#layout-6-content-0-content-row-0")
      .getByRole("button", { name: "Toggle block", exact: true })
      .press("Enter");
    await expect(preview.locator(`[data-payload-block="${inner.id}"]`)).toHaveAttribute(
      "data-payload-block-highlight",
      "",
    );
  });

  test(`${route} repeated markers skip hidden copies, scroll to the first rendered copy and expire`, async ({
    page,
  }) => {
    await login(page);
    const preview = await openLinkedPreview(page, seededPage.id, route);
    const id = seededPage.layout![5]!.id!;
    const copies = preview.locator(`[data-payload-block="${id}"]`);
    await copies.evaluateAll((elements) => {
      const original = elements[0]!;
      const hidden = original.cloneNode(true);
      if (!(hidden instanceof HTMLElement)) throw new Error("Missing copy");
      hidden.hidden = true;
      original.before(hidden);
      const repeated = original.cloneNode(true);
      if (!(repeated instanceof HTMLElement)) throw new Error("Missing repeated copy");
      repeated.style.marginTop = "100vh";
      original.after(repeated);
    });
    await expect(copies).toHaveCount(3);
    await copies.nth(2).scrollIntoViewIfNeeded();
    await expect(copies.nth(2)).toBeInViewport();
    await expect(copies.nth(1)).not.toBeInViewport();
    await page.locator("#field-layout__5__content").focus();
    await expect(copies.nth(1)).toBeInViewport();
    await expect(copies.nth(1)).toHaveAttribute("data-payload-block-highlight", "");
    await expect(copies.nth(0)).not.toHaveAttribute("data-payload-block-highlight", "");
    await expect(copies.nth(2)).not.toHaveAttribute("data-payload-block-highlight", "");
    await copies.nth(2).click();
    await expect(page.locator("#layout-row-5 > .blocks-field__row")).toHaveAttribute(
      "data-payload-block-highlight",
      "",
    );
    await copies.evaluateAll((elements) =>
      elements.forEach((element) => {
        if (element instanceof HTMLElement) element.hidden = true;
      }),
    );
    const header = page
      .locator("#layout-row-5")
      .getByRole("button", { name: "Toggle block", exact: true });
    await header.click();
    await copies.nth(2).evaluate((element) => {
      if (element instanceof HTMLElement) element.hidden = false;
    });
    await expect(copies.nth(2)).toHaveAttribute("data-payload-block-highlight", "");
    const timeouts: string[] = [];
    page.on("console", (message) => {
      if (message.text().includes("target timeout")) timeouts.push(message.text());
    });
    await copies.nth(2).evaluate((element) => {
      if (element instanceof HTMLElement) element.hidden = true;
    });
    await header.click();
    await expect.poll(() => timeouts.length).toBe(1);
    expect(timeouts[0]).toContain(id);
    await copies.nth(2).evaluate((element) => {
      if (element instanceof HTMLElement) element.hidden = false;
    });
    await expect(copies.nth(2)).not.toHaveAttribute("data-payload-block-highlight", "");
    await header.click();
    await expect(copies.nth(2)).toHaveAttribute("data-payload-block-highlight", "");
  });

  test(`${route} reordering and removing rows use current identities and ancestor fallback`, async ({
    page,
  }) => {
    const nested = await seedNestedPage(payload);
    const outer = nested.layout![6]!;
    if (outer.blockType !== "section") throw new Error("Missing outer section");
    const inner = outer.content![0]!;
    if (inner.blockType !== "section") throw new Error("Missing inner section");
    const deep = inner.content![0]!;
    await login(page);
    const preview = await openLinkedPreview(page, nested.id, route);
    await page.locator("#layout-row-6 > .blocks-field__row .array-actions__button").first().click();
    await page.getByRole("button", { name: "Move Up", exact: true }).click();
    const field = page.locator("#field-layout__5__content__0__content__0__content");
    await expect(field).toHaveValue("Deep target");
    const target = preview.locator(`[data-payload-block="${deep.id}"]`);
    await target.click();
    await expect(
      page.locator("#layout-5-content-0-content-row-0 > .blocks-field__row"),
    ).toHaveAttribute("data-payload-block-highlight", "");
    await field.focus();
    await expect(target).toHaveAttribute("data-payload-block-highlight", "");
    await expect(field).toBeFocused();
    await page.locator("#layout-5-content-0-content-row-0 .array-actions__button").click();
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(field).toHaveCount(0);
    // Preserve the stale preview's id chain while native autosave refreshes its content.
    await preview.locator("html").evaluate(
      (_element, ids) =>
        window.parent.postMessage(
          {
            type: "@codlume/payload-live-preview",
            event: "locate",
            ids,
          },
          window.location.origin,
        ),
      [deep.id, inner.id, outer.id],
    );
    await expect(page.locator("#layout-5-content-row-0 > .blocks-field__row")).toHaveAttribute(
      "data-payload-block-highlight",
      "",
    );
    await expect(page.locator("#layout-row-5 > .blocks-field__row")).not.toHaveAttribute(
      "data-payload-block-highlight",
      "",
    );
  });

  test(`${route} hidden Admin fields fall back through stale descendant form state`, async ({
    page,
  }) => {
    const nested = await seedNestedPage(payload);
    const outer = nested.layout![6]!;
    if (outer.blockType !== "section") throw new Error("Missing outer section");
    const inner = outer.content![0]!;
    if (inner.blockType !== "section") throw new Error("Missing inner section");
    const deep = inner.content![0]!;
    await login(page);
    const preview = await openLinkedPreview(page, nested.id, route);
    await preview.locator(`[data-payload-block="${deep.id}"]`).click();
    await expect(page.locator("#field-layout__6__content__0__content__0__content")).toHaveValue(
      "Deep target",
    );
    await page.locator("#field-layout__6__heading").fill("");
    await expect(
      page.locator("#field-layout__6__content__0__content__0__content"),
    ).not.toBeVisible();
    await preview.locator("html").evaluate(
      (_element, ids) =>
        window.parent.postMessage(
          {
            type: "@codlume/payload-live-preview",
            event: "locate",
            ids,
          },
          window.location.origin,
        ),
      [deep.id, inner.id, outer.id],
    );
    await expect(page.locator("#layout-row-6 > .blocks-field__row")).toHaveAttribute(
      "data-payload-block-highlight",
      "",
    );
  });
}
