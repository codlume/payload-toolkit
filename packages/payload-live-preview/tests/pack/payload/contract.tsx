import React from "react";
import { livePreviewPlugin, type LivePreviewPluginOptions } from "@codlume/payload-live-preview";
import { blockMarker, createPreviewBridge } from "@codlume/payload-live-preview/core";
import {
  createBlockRenderer,
  PreviewBridge,
  type BlockProps,
} from "@codlume/payload-live-preview/react";
import { PreviewBridgeAdmin } from "@codlume/payload-live-preview/client";
import type { Config, Plugin } from "payload";

const options = { enabled: true, debug: false } satisfies LivePreviewPluginOptions;
const plugin: Plugin = livePreviewPlugin(options);
const config: Partial<Config> = { plugins: [plugin] };
void config;
const attributes = blockMarker({ id: "row-1", blockType: "text" }, { draft: true });
createPreviewBridge({ serverURL: "https://cms.example.com" })();
const Block = ({ marker }: BlockProps<{ blockType: "text" }>) => <p {...marker}>Text</p>;
const Blocks = createBlockRenderer<{ blockType: "text" }>({ text: Block });
<Blocks blocks={[]} />;
<PreviewBridge serverURL="https://cms.example.com" />;
<PreviewBridgeAdmin debug={false} />;
void attributes;

// @ts-expect-error enabled is a boolean option
livePreviewPlugin({ enabled: "yes" });
