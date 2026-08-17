import config from "@payload-config";
import { generatePageMetadata, NotFoundPage } from "@payloadcms/next/views";

import { importMap } from "../importMap.js";

type PageArgs = {
  params: Promise<{ segments: string[] }>;
  searchParams: Promise<Record<string, string | string[]>>;
};

export const generateMetadata = ({ params, searchParams }: PageArgs) =>
  generatePageMetadata({ config, params, searchParams });

const NotFound = ({ params, searchParams }: PageArgs) =>
  NotFoundPage({ config, importMap, params, searchParams });

export default NotFound;
