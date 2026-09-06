"use client";
import { useEffect } from "react";
import { createPreviewBridge, type BridgeOptions } from "./bridge.ts";

export const PreviewBridge = ({ serverURL, debug = false }: BridgeOptions) => {
  useEffect(() => createPreviewBridge({ serverURL, debug }), [serverURL, debug]);
  return null;
};
