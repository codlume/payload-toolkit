import config from "@payload-config";
import { generatePageMetadata, RootPage } from "@payloadcms/next/views";

import { importMap } from "../importMap.js";

type PageArgs = {
  params: Promise<{ segments: string[] }>;
  searchParams: Promise<Record<string, string | string[]>>;
};

export const generateMetadata = ({ params, searchParams }: PageArgs) =>
  generatePageMetadata({ config, params, searchParams });

const Page = ({ params, searchParams }: PageArgs) =>
  RootPage({ config, importMap, params, searchParams });

export default Page;
