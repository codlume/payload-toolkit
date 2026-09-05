"use client";

import React from "react";
import { PreviewBridge } from "@codlume/payload-live-preview/react";
import { Blocks, blocks } from "../blocks.tsx";

export default function ClientPage() {
  return (
    <main>
      <Blocks blocks={blocks} draft parentProps={{ content: "Client: " }} />
      <PreviewBridge serverURL="https://cms.example.com" />
    </main>
  );
}
