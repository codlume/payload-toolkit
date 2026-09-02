"use client";

// PROTOTYPE — throwaway. Subscribes to Payload's own `payload-live-preview` stream
// (what `@payloadcms/live-preview-react` does) and renders the layout with markers.

import { useEffect, useState } from "react";

import { type LayoutBlock, RenderLayout } from "./blocks.tsx";
import { PreviewBridge } from "./preview-bridge.tsx";

type PageData = { layout?: LayoutBlock[] | null; title?: string | null };

export const PreviewPage = ({
  initialData,
  serverURL,
}: {
  initialData: PageData;
  serverURL: string;
}) => {
  const [data, setData] = useState(initialData);

  useEffect(() => {
    if (window.parent === window) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== serverURL) return;
      const message: unknown = event.data;
      if (typeof message !== "object" || message === null) return;
      const record = message as { data?: PageData; type?: string };
      if (record.type === "payload-live-preview" && record.data) setData(record.data);
    };
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ type: "payload-live-preview", ready: true }, serverURL);
    return () => window.removeEventListener("message", onMessage);
  }, [serverURL]);

  return (
    <main className="page">
      <RenderLayout blocks={data.layout} draft />
      <PreviewBridge serverURL={serverURL} />
    </main>
  );
};
