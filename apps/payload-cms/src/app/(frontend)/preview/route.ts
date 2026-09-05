import { redirect } from "next/navigation";
import { draftMode, headers } from "next/headers";
import { getPayload } from "payload";
import config from "../../../payload.config.ts";

export async function GET(request: Request) {
  const payload = await getPayload({ config });
  const { user } = await payload.auth({ headers: await headers() });
  if (!user) return new Response("Sign in to preview drafts.", { status: 401 });
  const params = new URL(request.url).searchParams;
  const slug = params.get("slug");
  if (!slug) return new Response("A page slug is required.", { status: 400 });
  (await draftMode()).enable();
  const route = params.get("mode") === "client" ? "pages-client" : "pages";
  return redirect(`/${route}/${encodeURIComponent(slug)}`);
}
