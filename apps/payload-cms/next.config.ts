import path from "node:path";

import { withPayload } from "@payloadcms/next/withPayload";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.PAYLOAD_NEXT_DIST_DIRECTORY ?? ".next",
  turbopack: {
    root: path.resolve(import.meta.dirname),
  },
  typescript: {
    tsconfigPath: process.env.PAYLOAD_NEXT_TSCONFIG_PATH ?? "tsconfig.json",
  },
  webpack: (webpackConfig) => {
    webpackConfig.resolve.alias["@payloadcms/ui$"] = path.resolve(
      import.meta.dirname,
      "node_modules/@payloadcms/ui/dist/exports/client/index.js",
    );

    return webpackConfig;
  },
};

export default withPayload(nextConfig, { devBundleServerPackages: false });
