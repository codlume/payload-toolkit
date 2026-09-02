import config from "@payload-config";
import { notFound } from "next/navigation";
import { getPayload } from "payload";

import { PreviewPage } from "../../../../../prototype-live-preview-linking/preview-page.tsx";
import { serverURL } from "../../../../../prototype-live-preview-linking/server-url.ts";

// PROTOTYPE — throwaway preview route: `/prototype/pages/<id>`, always a draft render.
export const dynamic = "force-dynamic";

const Page = async ({ params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const payload = await getPayload({ config });
  const page = await payload
    .findByID({ collection: "pages", id, depth: 0, draft: true })
    .catch(() => null);
  if (!page) notFound();
  return <PreviewPage initialData={page} serverURL={serverURL} />;
};

export default Page;
