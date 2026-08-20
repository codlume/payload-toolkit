import { writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test, type Request } from "@playwright/test";
import sharp from "sharp";

import { createE2EPayload, seedAdminUser, seedPreviewDocuments } from "./e2e-context.ts";
import { login } from "./login.ts";

type SeededDocuments = Awaited<ReturnType<typeof seedPreviewDocuments>>;

let documents: SeededDocuments;
let directUploadFile: string;
let directUploadSize: number;
let payload: Awaited<ReturnType<typeof createE2EPayload>>;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  payload = await createE2EPayload("enabled");
  await seedAdminUser(payload);
  documents = await seedPreviewDocuments(payload);
  directUploadFile = path.join(
    process.env.PAYLOAD_E2E_STATE_DIRECTORY ?? "",
    "direct-client-upload.jpg",
  );
  const directUpload = await sharp({
    create: {
      background: { b: 80, g: 120, r: 200 },
      channels: 3,
      height: 768,
      width: 1024,
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
  await writeFile(directUploadFile, directUpload);
  directUploadSize = directUpload.length;
});

test.afterAll(async () => {
  await payload.db.destroy?.();
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const metrics = { draws: 0 };
    const prototype = CanvasRenderingContext2D.prototype;
    const putImageData = Reflect.get(prototype, "putImageData");

    if (typeof putImageData === "function") {
      Object.defineProperty(prototype, "putImageData", {
        configurable: true,
        value: function (
          this: CanvasRenderingContext2D,
          ...args:
            | [ImageData, number, number]
            | [ImageData, number, number, number, number, number, number]
        ) {
          if (this.canvas.hasAttribute("data-blurhash-preview")) {
            metrics.draws += 1;
          }

          Reflect.apply(putImageData, this, args);
        },
      });
    }

    Reflect.set(window, "__blurHashPreviewMetrics", metrics);
  });

  await login(page);
});

const getDrawCount = async (page: Parameters<typeof login>[0]) =>
  page.evaluate(() => {
    const metrics = Reflect.get(window, "__blurHashPreviewMetrics");

    if (typeof metrics !== "object" || metrics === null || !("draws" in metrics)) {
      return -1;
    }

    return typeof metrics.draws === "number" ? metrics.draws : -1;
  });

test("generated value renders one bounded static accessible preview", async ({ page }) => {
  await page.goto(`/admin/collections/media/${documents.validID}`);

  const panel = page.locator("[data-blurhash-panel]");
  const canvas = panel.locator("canvas[data-blurhash-preview]");
  const input = panel.getByLabel("BlurHash");

  await expect(panel.getByText("Generated automatically from the current image.")).toBeVisible();
  await expect(input).toHaveAttribute("readonly", "");
  await expect(input).not.toBeDisabled();
  await expect(panel).toHaveClass(/\bfield-type\b/);
  await expect(panel).toHaveClass(/\bread-only\b/);
  await expect(panel).toHaveClass(/\btext\b/);
  await expect(panel.getByText("Read-only value")).toHaveCount(0);
  await expect(canvas).toHaveAttribute("aria-hidden", "true");
  await expect(canvas).toHaveAttribute("tabindex", "-1");
  await expect.poll(() => getDrawCount(page)).toBe(1);

  const description = panel.getByText("Generated automatically from the current image.");
  const inputBounds = await input.boundingBox();
  const descriptionBounds = await description.boundingBox();
  const surfaceBounds = await panel.locator("[data-blurhash-preview-surface]").boundingBox();

  if (!descriptionBounds || !inputBounds || !surfaceBounds) {
    throw new Error("Expected the compact preview layout to be visible.");
  }

  expect({
    descriptionBelowInput: descriptionBounds.y >= inputBounds.y + inputBounds.height,
    descriptionLeftAligned: Math.abs(descriptionBounds.x - inputBounds.x) < 1,
    inputTopAlignedWithPreview: Math.abs(inputBounds.y - surfaceBounds.y) < 1,
  }).toEqual({
    descriptionBelowInput: true,
    descriptionLeftAligned: true,
    inputTopAlignedWithPreview: true,
  });

  const canvasMetrics = await canvas.evaluate((element) => {
    if (!(element instanceof HTMLCanvasElement)) {
      throw new TypeError("Expected the preview surface to contain a canvas.");
    }

    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);

    return {
      animationName: style.animationName,
      cssHeight: bounds.height,
      cssWidth: bounds.width,
      intrinsicHeight: element.height,
      intrinsicWidth: element.width,
      transitionDuration: style.transitionDuration,
    };
  });

  await page.waitForTimeout(250);

  expect(canvasMetrics.cssHeight).toBeCloseTo(96, 2);
  expect(canvasMetrics.cssWidth / canvasMetrics.cssHeight).toBeCloseTo(5 / 3, 4);
  expect({
    animationName: canvasMetrics.animationName,
    buttons: await panel.getByRole("button").count(),
    cssWidth: canvasMetrics.cssWidth,
    drawCount: await getDrawCount(page),
    intrinsicHeight: canvasMetrics.intrinsicHeight,
    intrinsicWidth: canvasMetrics.intrinsicWidth,
    liveRegions: await panel.locator("[aria-live]").count(),
    longestIntrinsicEdge: Math.max(canvasMetrics.intrinsicWidth, canvasMetrics.intrinsicHeight),
    transitionDuration: canvasMetrics.transitionDuration,
  }).toEqual({
    animationName: "none",
    buttons: 0,
    cssWidth: 160,
    drawCount: 1,
    intrinsicHeight: 19,
    intrinsicWidth: 32,
    liveRegions: 0,
    longestIntrinsicEdge: 32,
    transitionDuration: "0s",
  });
});

test("preview layout stacks at a narrow viewport", async ({ page }) => {
  await page.goto(`/admin/collections/media/${documents.validID}`);

  const surface = page.locator("[data-blurhash-preview-surface]");
  const details = page.locator("[data-blurhash-details]");
  const desktop = {
    details: await details.boundingBox(),
    surface: await surface.boundingBox(),
  };

  await page.setViewportSize({ height: 900, width: 360 });

  const narrow = {
    details: await details.boundingBox(),
    surface: await surface.boundingBox(),
  };

  if (!desktop.details || !desktop.surface || !narrow.details || !narrow.surface) {
    throw new Error("Expected preview layout columns to be visible.");
  }

  expect({
    desktopDetailsToRight: desktop.details.x > desktop.surface.x,
    narrowDetailsBelow: narrow.details.y > narrow.surface.y,
    narrowHorizontalAlignment: Math.abs(narrow.details.x - narrow.surface.x) < 1,
  }).toEqual({
    desktopDetailsToRight: true,
    narrowDetailsBelow: true,
    narrowHorizontalAlignment: true,
  });

  await surface.evaluate((element) => {
    element.style.maxWidth = "144px";
  });
  const narrowCanvas = await surface.locator("canvas").boundingBox();

  if (!narrowCanvas) {
    throw new Error("Expected the narrow preview canvas to be visible.");
  }

  expect(narrowCanvas.width / narrowCanvas.height).toBeCloseTo(5 / 3, 2);
});

test("missing value renders the neutral no-value state", async ({ page }) => {
  await page.goto(`/admin/collections/media/${documents.missingID}`);

  const panel = page.locator("[data-blurhash-panel]");
  const input = panel.getByLabel("BlurHash");

  await expect(panel.getByText("No value", { exact: true })).toBeVisible();
  await expect(panel.getByText("No BlurHash is available for this image.")).toBeVisible();
  await expect(input).toHaveValue("");
  await expect(panel.locator("canvas")).toHaveCount(0);
});

test("invalid value stays selectable while the form remains usable", async ({ page }) => {
  await page.goto(`/admin/collections/media/${documents.invalidID}`);

  const panel = page.locator("[data-blurhash-panel]");
  const input = panel.getByLabel("BlurHash");

  await expect(panel.getByText("Preview unavailable", { exact: true })).toBeVisible();
  await expect(
    panel.getByText("The stored BlurHash could not be decoded. Its original value is preserved."),
  ).toBeVisible();
  await expect(input).toHaveValue("not-a-blurhash");
  await expect(input).not.toBeDisabled();
  await expect(page.getByRole("button", { name: "Publish changes" })).toBeVisible();
});

test("authenticated uploads send file bytes directly to S3", async ({ page }) => {
  const payloadHost = new URL(page.url()).host;
  const s3Host = new URL(process.env.PAYLOAD_S3_ENDPOINT ?? "http://127.0.0.1:4566").host;
  const largeRequestsToPayload: string[] = [];
  const putsToS3: string[] = [];
  const requestObservations: Promise<void>[] = [];

  const observeRequest = (request: Request) => {
    const requestURL = new URL(request.url());
    const isPayloadRequest = requestURL.host === payloadHost;
    const isS3Put = requestURL.host === s3Host && request.method() === "PUT";

    if (isS3Put) {
      putsToS3.push(request.url());
    }

    if (!isPayloadRequest) {
      return;
    }

    requestObservations.push(
      (async () => {
        const contentLength = Number((await request.headerValue("content-length")) ?? 0);

        if (isPayloadRequest && contentLength >= directUploadSize) {
          largeRequestsToPayload.push(`${request.method()} ${request.url()}`);
        }
      })(),
    );
  };

  await page.goto("/admin/collections/media/create");
  page.on("request", observeRequest);
  await page.setInputFiles('input[type="file"]', directUploadFile);
  await page.getByRole("button", { name: "Publish changes" }).click();
  await expect(page).toHaveURL(/\/admin\/collections\/media\/[^/]+$/);
  await expect.poll(() => putsToS3.length).toBe(1);
  page.off("request", observeRequest);
  await Promise.all(requestObservations);

  expect({ largeRequestsToPayload, putsToS3: putsToS3.length }).toEqual({
    largeRequestsToPayload: [],
    putsToS3: 1,
  });
});
