import React from "react";
import { ClientPage } from "../../../../preview/client-page.tsx";
import { draftMode, headers } from "next/headers";
import { notFound } from "next/navigation";
import { PageBlocks } from "../../../../preview/blocks.tsx";
import { readPage } from "../../../../preview/read-page.ts";

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const requestHeaders = await headers();
  const { page, draft } = await readPage(
    (await params).slug,
    (await draftMode()).isEnabled,
    requestHeaders,
  );
  if (!page) notFound();
  const serverURL =
    process.env.PAYLOAD_PUBLIC_SERVER_URL ??
    `${requestHeaders.get("x-forwarded-proto") ?? "http"}://${requestHeaders.get("host")}`;
  if (draft) {
    return (
      <ClientPage
        initialData={page}
        serverURL={serverURL}
        debug={process.env.PAYLOAD_LIVE_PREVIEW_DEBUG === "true"}
      />
    );
  }
  return (
    <main>
      <h1 style={{ padding: "32px" }}>{page.title}</h1>
      <PageBlocks blocks={page.layout} draft={false} parentProps={{ textClass: "page-text" }} />
    </main>
  );
}
