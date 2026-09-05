import React from "react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getPayload } from "payload";
import { PreviewBridge } from "@codlume/payload-live-preview/react";
import config from "../../../payload.config.ts";
import { PageBlocks } from "../../../preview/blocks.tsx";
import { PreviewRefresh } from "../../../preview/refresh.tsx";
import {
  ClientGlobal,
  type PreviewGlobalData,
} from "../../../../tests/fixtures/preview-global.tsx";

/** Authenticated preview for the opt-in localized global test configuration. */
export default async function GlobalPreview({
  searchParams,
}: {
  searchParams: Promise<{ locale?: string; mode?: string }>;
}) {
  if (process.env.PAYLOAD_LIVE_PREVIEW_TEST_CONTEXT !== "true") notFound();
  const payload = await getPayload({ config });
  const requestHeaders = await headers();
  const { user } = await payload.auth({ headers: requestHeaders });
  if (!user) notFound();
  const params = await searchParams;
  const global: PreviewGlobalData = await payload.findGlobal({
    slug: "site-settings",
    // @ts-expect-error -- Locales exist only in the opt-in test schema, not the generated public schema.
    locale: params.locale === "pl" ? "pl" : "en",
    user,
    overrideAccess: false,
    depth: 0,
  });
  const serverURL = process.env.PAYLOAD_PUBLIC_SERVER_URL ?? `http://${requestHeaders.get("host")}`;
  if (params.mode === "client") return <ClientGlobal initialData={global} serverURL={serverURL} />;
  return (
    <main>
      <h1>{global.siteName}</h1>
      <PageBlocks blocks={global.layout} draft={true} parentProps={{ textClass: "page-text" }} />
      <PreviewRefresh serverURL={serverURL} />
      <PreviewBridge serverURL={serverURL} debug={true} />
    </main>
  );
}
