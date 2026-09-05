"use client";
import React from "react";
import { useLivePreview } from "@payloadcms/live-preview-react";
import { PreviewBridge } from "@codlume/payload-live-preview/react";
import type { Page } from "../payload-types.generated.ts";
import { PageBlocks } from "./blocks.tsx";

/** Native Payload streaming updates the same marked components used by the server route. */
export const ClientPage = ({
  initialData,
  serverURL,
  debug,
}: {
  initialData: Page;
  serverURL: string;
  debug: boolean;
}) => {
  const { data } = useLivePreview<Page>({ initialData, serverURL, depth: 0 });
  return (
    <main>
      <h1 style={{ padding: "32px" }}>{data.title}</h1>
      <PageBlocks blocks={data.layout} draft={true} parentProps={{ textClass: "page-text" }} />
      <PreviewBridge serverURL={serverURL} debug={debug} />
    </main>
  );
};
