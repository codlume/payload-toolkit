"use client";
import React from "react";
import { useLivePreview } from "@payloadcms/live-preview-react";
import { PreviewBridge } from "@codlume/payload-live-preview/react";
import type { Page, SiteSetting } from "../../src/payload-types.generated.ts";
import { PageBlocks } from "../../src/preview/blocks.tsx";

// The extra fields exist only in the opt-in global schema.
export type PreviewGlobalData = SiteSetting & Pick<Page, "layout">;

export const ClientGlobal = ({
  initialData,
  serverURL,
}: {
  initialData: PreviewGlobalData;
  serverURL: string;
}) => {
  const { data } = useLivePreview<PreviewGlobalData>({ initialData, serverURL, depth: 0 });
  return (
    <main>
      <h1>{data.siteName}</h1>
      <PageBlocks blocks={data.layout} draft={true} parentProps={{ textClass: "page-text" }} />
      <PreviewBridge serverURL={serverURL} debug={true} />
    </main>
  );
};
