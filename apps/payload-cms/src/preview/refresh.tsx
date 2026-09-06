"use client";
import React from "react";
import { RefreshRouteOnSave } from "@payloadcms/live-preview-react";
import { useRouter } from "next/navigation";

export const PreviewRefresh = ({ serverURL }: { serverURL: string }) => {
  const router = useRouter();
  return <RefreshRouteOnSave refresh={() => router.refresh()} serverURL={serverURL} />;
};
