// "Download all" as one zip, built in the browser while it downloads (nothing large runs on the server).
// The gallery page registers this for /zip/ only, then opens /zip/<slug>/<name>.zip; we answer that request with
// a streamed zip of the client's purchased files (or, from the studio, ?ids= Keri picked), fetched straight from R2. Library: client-zip 2.5.1 (MIT).
importScripts("/assets/vendor/client-zip-2.5.1.worker.js");

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // /zip-studio/ is the studio's own registration, so it always runs this version (it knows ?ids=)
  const m = url.pathname.match(/^\/zip(?:-studio)?\/([^/]+)\/[^/]+\.zip$/);
  if (!m) return;
  event.respondWith(zipResponse(event, decodeURIComponent(m[1]), url.searchParams.get("ids")));
});

function problem(msg, status = 500) {
  return new Response(`<!doctype html><meta charset="utf-8"><p style="font:16px system-ui;padding:24px">${msg}</p>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

async function zipResponse(event, slug, ids) {
  const res = await fetch(`/api/download-list?slug=${encodeURIComponent(slug)}${ids ? `&ids=${encodeURIComponent(ids)}` : ""}`, { credentials: "same-origin" });
  if (!res.ok) return problem(res.status === 401 ? "Please sign in to the gallery first." : "Couldn't get your files. Please try again.", res.status);
  const { zipName, files } = await res.json();
  if (!files.length) return problem("There are no files to download yet.", 404);

  async function* inputs() {
    for (const f of files) {
      const r = await fetch(f.url, { credentials: f.url.startsWith("/") ? "same-origin" : "omit" });
      if (!r.ok) throw new Error(`${f.name}: ${r.status}`);
      yield { name: f.name, lastModified: new Date(), input: r };
    }
  }
  const metadata = files.every((f) => f.size) ? files.map((f) => ({ name: f.name, size: f.size })) : undefined;
  const zip = downloadZip(inputs(), metadata ? { metadata } : {});

  // Keep the worker alive until the last byte is handed over (Firefox may otherwise stop it mid-download).
  let finished;
  event.waitUntil(new Promise((r) => (finished = r)));
  const reader = zip.body.getReader();
  const body = new ReadableStream({
    async pull(c) {
      try {
        const { done, value } = await reader.read();
        if (done) { c.close(); finished(); } else c.enqueue(value);
      } catch (err) { c.error(err); finished(); }
    },
    cancel(reason) { reader.cancel(reason); finished(); },
  });

  const headers = new Headers(zip.headers);
  headers.set("content-type", "application/zip");
  headers.set("content-disposition", `attachment; filename="${zipName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(zipName)}`);
  headers.set("cache-control", "no-store");
  return new Response(body, { headers });
}
