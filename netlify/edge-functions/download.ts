// Streams a full-resolution file to the client, only if it has been purchased
// (or the requester is signed in as admin). Files are stored as 4 MB chunks in Blobs.
import type { Config, Context } from "@netlify/edge-functions";
import { getClient, getState, isClientAuthed, isAdmin, fileStore, r2, r2Key, r2Presign } from "../../lib/core.mjs";

export default async (req: Request, context: Context) => {
  const { slug, id } = context.params as { slug: string; id: string };
  const client = getClient(slug);
  if (!client) return new Response("Not found", { status: 404 });
  if (!(await isClientAuthed(req, slug))) return new Response("Please sign in to the gallery first.", { status: 401 });

  const admin = await isAdmin(req);
  if (!admin) {
    const state = await getState(client);
    if (!state.purchased[id]) return new Response("This file hasn't been purchased yet.", { status: 402 });
  }

  const store = fileStore();
  const meta: any = await store.get(`meta/${slug}/${id}`, { type: "json" });
  if (!meta) return new Response("This file is still being prepared. Check back soon.", { status: 404 });

  if (meta.storage === "r2" && r2()) {
    // Hand the browser a 10-minute signed link straight to Cloudflare R2 (no size limits, no egress fees).
    const safe = String(meta.filename).replace(/"/g, "");
    const url = await r2Presign("GET", r2Key(slug, id), 600, {
      "response-content-disposition": `attachment; filename="${safe}"`,
      "response-content-type": meta.contentType || "application/octet-stream",
    });
    return new Response(null, { status: 302, headers: { location: url, "cache-control": "private, no-store" } });
  }

  let part = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      if (part >= meta.parts) return controller.close();
      const buf = await store.get(`parts/${slug}/${id}/${String(part).padStart(5, "0")}`, { type: "arrayBuffer" });
      if (!buf) return controller.error(new Error(`missing part ${part}`));
      controller.enqueue(new Uint8Array(buf as ArrayBuffer));
      part++;
    },
  });

  const headers: Record<string, string> = {
    "content-type": meta.contentType || "application/octet-stream",
    "content-disposition": `attachment; filename="${String(meta.filename).replace(/"/g, "")}"`,
    "cache-control": "private, no-store",
  };
  if (meta.size) headers["content-length"] = String(meta.size);
  return new Response(stream, { headers });
};

export const config: Config = { path: "/dl/:slug/:id" };
