import React from "react";
import { PreviewBridge } from "@codlume/payload-live-preview/react";
import { Blocks, blocks } from "./blocks.tsx";

export default function ServerPage() {
  return (
    <main>
      <Blocks blocks={blocks} draft parentProps={{ content: "Server: " }} />
      <Blocks blocks={blocks} parentProps={{ content: "Published: " }} />
      <PreviewBridge serverURL="https://cms.example.com" />
    </main>
  );
}
