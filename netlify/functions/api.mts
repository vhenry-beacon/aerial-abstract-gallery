import type { Config, Context } from "@netlify/functions";
import {
  getClient, listClients, getState, saveState, quote, fulfillOrder, saveOrder, getOrder, listOrders,
  json, signToken, cookieName, setCookieHeader, isClientAuthed, isAdmin, checkAdminPassword, sha256Hex,
  fileStore, PART_SIZE, stripe, stripeKey, verifyStripeSignature, siteUrl,
  r2, r2Key, r2Presign, r2Head, storageMode, downloadName, zipName,
  r2List, r2MultipartStart, r2PartUrl, r2MultipartParts, r2MultipartComplete, r2MultipartAbort,
  getReview, saveReview, clientCanSee, REVIEW_STATUSES,
  editWaiting, reelWaiting, noteWaiting, getProject, saveProject, listProjects, PROJECT_STATUSES, getWorker, setWorker,
} from "../../lib/core.mjs";

const CLAUDE_STATES = ["waiting", "working", "ready", "problem"];
const bad = (msg: string, status = 400) => json({ error: msg }, { status });

function publicClient(c: any) {
  return {
    slug: c.slug, clientName: c.clientName, eventName: c.eventName, eventDate: c.eventDate,
    welcome: c.welcome, provider: c.provider,
    package: { name: c.package.name, price: c.package.price, included: c.package.included },
    extraPrice: c.extraPrice,
    upsells: (c.upsells || []).map((u: any) => ({ id: u.id, name: u.name, price: u.price, description: u.description, preview: u.preview, poster: u.poster, unlocks: u.unlocks })),
  };
}

async function fileMetas(slug: string) {
  const store = fileStore();
  const { blobs } = await store.list({ prefix: `meta/${slug}/` });
  const out: Record<string, any> = {};
  for (const b of blobs) {
    const m = await store.get(b.key, { type: "json" });
    if (m) out[b.key.split("/").pop()!] = m;
  }
  return out;
}

// `admin` = Keri previewing: she sees exactly what the client will see once the gallery is published.
async function galleryPayload(client: any, admin = false) {
  const state = await getState(client);
  const metas = await fileMetas(client.slug);
  const review = await getReview(client.slug);
  const asPublished = admin ? { ...review, published: true } : review;
  const visible = client.items.filter((i: any) => clientCanSee(i, asPublished, state));
  return {
    client: publicClient(client),
    items: visible.map((i: any) => ({
      id: i.id, type: i.type, title: i.title, preview: i.preview, poster: i.poster,
      duration: i.duration, orientation: i.orientation, upsellOnly: !!i.upsellOnly,
      ready: !!metas[i.id],
    })),
    state: { packagePaid: state.packagePaid, selected: state.selected, cartUpsells: state.cartUpsells, purchased: state.purchased },
    quote: quote(client, state),
    paymentsEnabled: !!stripeKey(),
    ...(admin ? { adminPreview: { published: review.published, hidden: client.items.length - visible.length } } : {}),
  };
}

// Edit requests from the studio. Numbers are clamped so the renderer can trust them.
const num = (v: any, lo: number, hi: number, d = 0) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
const LOOKS = ["original", "bright", "warm", "cool", "vivid", "cinematic", "matte", "bw", "vintage"];
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2, 4];
function cleanLook(l: any) {
  if (!l) return null;
  return {
    preset: LOOKS.includes(l.preset) ? l.preset : "original",
    brightness: num(l.brightness, -0.5, 0.5), contrast: num(l.contrast, -0.5, 0.5),
    saturation: num(l.saturation, -1, 1), warmth: num(l.warmth, -1, 1), fade: num(l.fade, 0, 1),
  };
}
function cleanEdit(e: any, item: any) {
  if (!e) return null;
  const out: any = { look: cleanLook(e.look) };
  if (item.type === "video") {
    out.speed = SPEEDS.includes(Number(e.speed)) ? Number(e.speed) : 1;
    const dur = Number(item.duration) || 3600;
    if (Array.isArray(e.trim)) {
      const a = num(e.trim[0], 0, dur), b = num(e.trim[1], 0, dur, dur);
      out.trim = b - a >= 0.5 ? [Math.round(a * 100) / 100, Math.round(b * 100) / 100] : null;
    }
  }
  return out;
}
function cleanReel(r: any, client: any) {
  const clips = new Map(client.items.filter((i: any) => i.type === "video" && !i.upsellOnly).map((i: any) => [i.id, i]));
  const pieces = (r.pieces || []).slice(0, 40).flatMap((p: any) => {
    const c: any = clips.get(p.clip);
    if (!c) return [];
    const a = num(p.in, 0, c.duration), b = num(p.out, 0, c.duration, c.duration);
    if (b - a < 0.3) return [];
    return [{ clip: c.id, in: Math.round(a * 100) / 100, out: Math.round(b * 100) / 100,
      speed: SPEEDS.includes(Number(p.speed)) ? Number(p.speed) : 1, look: cleanLook(p.look) }];
  });
  const text = (s: any, n = 80) => String(s ?? "").slice(0, n);
  return {
    pieces, look: cleanLook(r.look), title: text(r.title), subtitle: text(r.subtitle), endcard: text(r.endcard),
    transition: r.transition === "cut" ? "cut" : "fade", music: text(r.music, 300),
  };
}

// ---- projects: Keri's quote + instructions + raw files, which Claude turns into a gallery ----
const str = (v: any, n = 200) => String(v ?? "").trim().slice(0, n);
const cents = (v: any) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : 0);
function cleanProject(b: any, prev: any = {}) {
  const q = b.quote || {};
  return {
    ...prev,
    name: str(b.name ?? prev.name, 120) || prev.name,
    client: { name: str(b.client?.name, 120), email: str(b.client?.email, 160), phone: str(b.client?.phone, 40) },
    event: { name: str(b.event?.name, 120), date: str(b.event?.date, 10), location: str(b.event?.location, 160) },
    quote: {
      packageName: str(q.packageName, 80), price: cents(q.price), included: Math.min(500, cents(q.included)),
      extraPrice: cents(q.extraPrice), due: str(q.due, 10), description: str(q.description, 8000),
      addons: (Array.isArray(q.addons) ? q.addons : []).slice(0, 10)
        .map((a: any) => ({ name: str(a.name, 80), price: cents(a.price), description: str(a.description, 400) }))
        .filter((a: any) => a.name),
    },
    instructions: str(b.instructions, 8000),
  };
}
async function projectSummary(p: any, rawFolders: Set<string>) {
  let status = "quote", cover = null, counts = null;
  const client = p.gallerySlug ? getClient(p.gallerySlug) : null;
  if (client) {
    const [review, state, orders] = await Promise.all([getReview(client.slug), getState(client), listOrders(client.slug)]);
    // Stripe test-mode orders (cs_test_ sessions) don't make a project "Paid"
    const realPaid = orders.some((o: any) => o.status === "paid" && !String(o.stripeSessionId || "").startsWith("cs_test_"));
    status = state.packagePaid || realPaid ? "paid" : review.published ? "published" : "reviewing";
    const photo = client.items.find((i: any) => i.type === "photo") || client.items.find((i: any) => i.poster);
    cover = photo ? photo.preview || photo.poster : null;
    const items = client.items.filter((i: any) => !i.upsellOnly);
    counts = {
      items: items.length,
      approved: items.filter((i: any) => review.items[i.id]?.status === "approved").length,
      waiting: items.filter((i: any) => editWaiting(review.items[i.id])).length + (reelWaiting(review.reel) ? 1 : 0),
      notes: items.filter((i: any) => noteWaiting(review.items[i.id])).length + (noteWaiting(review.reel) ? 1 : 0),
    };
  } else if (p.sentToClaudeAt) status = "claude";
  else if (rawFolders.has(p.id)) status = "files";
  // "With Claude" tiles say which part: waiting to be picked up, working, or stuck on a question for Keri
  const cs = status === "claude" || ["waiting", "working", "problem"].includes(p.claudeState?.state) ? p.claudeState?.state : null;
  const label = PROJECT_STATUSES[(cs && cs !== "ready" ? cs : status) as keyof typeof PROJECT_STATUSES];
  return { ...p, accessCode: undefined, status, statusLabel: label, cover, counts, hasFiles: rawFolders.has(p.id) };
}
async function rawProjectFolders() {
  if (!r2()) return new Set<string>();
  const { folders } = await r2List("raw/", "/");
  return new Set(folders.map((f: string) => f.slice(4).replace(/\/$/, "")));
}

// Raw-upload projects are folders under raw/ in R2 (a gallery slug or any other short name).
const projectName = (p: any) => String(p || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
const safePath = (p: any) => String(p || "").replace(/\\/g, "/").split("/").filter((s) => s && s !== "." && s !== ".." && !s.startsWith("._")).join("/").slice(0, 400);

async function readJson(req: Request) {
  try { return await req.json(); } catch { return {}; }
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "");
  const m = req.method;

  try {
    // ---------------- client endpoints ----------------
    if (route === "login" && m === "POST") {
      const { slug, code } = await readJson(req);
      const client = getClient(slug);
      if (!client) return bad("Gallery not found", 404);
      const ok = (await sha256Hex(String(code || "").trim().toUpperCase())) === client.accessCodeHash;
      if (!ok) return bad("That access code didn't match. Check the code Keri sent you.", 401);
      return json({ ok: true }, { headers: { "set-cookie": setCookieHeader(cookieName(slug), await signToken(slug, 60), 60) } });
    }

    if (route === "gallery" && m === "GET") {
      const client = getClient(url.searchParams.get("slug"));
      if (!client) return bad("Gallery not found", 404);
      if (!(await isClientAuthed(req, client.slug))) {
        return json({ needsLogin: true, client: { clientName: client.clientName, eventName: client.eventName, provider: client.provider } }, { status: 401 });
      }
      const admin = await isAdmin(req);
      if (!admin && !(await getReview(client.slug)).published) {
        return json({ notPublished: true, client: { clientName: client.clientName, eventName: client.eventName, provider: client.provider } });
      }
      return json(await galleryPayload(client, admin));
    }

    if (route === "select" && m === "POST") {
      const { slug, id, upsell, on } = await readJson(req);
      const client = getClient(slug);
      if (!client) return bad("Gallery not found", 404);
      if (!(await isClientAuthed(req, slug))) return bad("Please sign in", 401);
      const state = await getState(client);
      if (upsell) {
        if (!(client.upsells || []).some((u: any) => u.id === upsell)) return bad("Unknown add-on");
        state.cartUpsells = state.cartUpsells.filter((x: string) => x !== upsell);
        if (on) state.cartUpsells.push(upsell);
      } else {
        const item = client.items.find((i: any) => i.id === id && !i.upsellOnly);
        if (!item) return bad("Unknown item");
        if (state.purchased[id]) return bad("Already yours");
        const admin = await isAdmin(req);
        const review = await getReview(slug);
        if (on && !clientCanSee(item, admin ? { ...review, published: true } : review, state)) return bad("That item isn't available yet");
        state.selected = state.selected.filter((x: string) => x !== id);
        if (on) state.selected.push(id);
      }
      await saveState(client, state);
      return json(await galleryPayload(client, await isAdmin(req)));
    }

    if (route === "checkout" && m === "POST") {
      const { slug, email } = await readJson(req);
      const client = getClient(slug);
      if (!client) return bad("Gallery not found", 404);
      if (!(await isClientAuthed(req, slug))) return bad("Please sign in", 401);
      const state = await getState(client);
      const q = quote(client, state);
      if (!q.cart.length && !q.upsells.length && !q.packageIncluded) return bad("Your cart is empty");
      const order: any = {
        id: crypto.randomUUID(), slug, createdAt: new Date().toISOString(), status: "pending",
        lines: q.lines, total: q.total, assign: q.assign, upsells: q.upsells, packageIncluded: q.packageIncluded,
      };
      if (q.total === 0) {
        // Package already paid and picks fit inside the remaining included slots: no charge.
        await saveOrder(order);
        await fulfillOrder(client, order, "included");
        return json({ claimed: true, ...(await galleryPayload(client, await isAdmin(req))) });
      }
      if (!stripeKey()) return bad("Online payment isn't switched on yet. Your picks are saved. Keri will follow up with a payment link.", 503);
      const base = siteUrl(req);
      const params: any = {
        mode: "payment",
        success_url: `${base}/api/confirm?slug=${encodeURIComponent(slug)}&order=${order.id}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}/g/${encodeURIComponent(slug)}?canceled=1`,
        client_reference_id: order.id,
        metadata: { slug, orderId: order.id },
        payment_intent_data: { description: `${client.clientName} · ${client.eventName}`, metadata: { slug, orderId: order.id } },
        line_items: {},
      };
      if (email || client.contactEmail) params.customer_email = email || client.contactEmail;
      q.lines.forEach((l: any, i: number) => {
        params.line_items[i] = { quantity: l.qty, price_data: { currency: "usd", unit_amount: l.unit, product_data: { name: l.name } } };
      });
      const session = await stripe("POST", "checkout/sessions", params);
      order.stripeSessionId = session.id;
      await saveOrder(order);
      return json({ url: session.url });
    }

    // Every purchased, ready file with its friendly name, size and a 6-hour link: feeds the "Download all" zip
    // (public/zip-sw.js builds the zip in the browser, so nothing large runs on the server).
    if (route === "download-list" && m === "GET") {
      const client = getClient(url.searchParams.get("slug"));
      if (!client) return bad("Gallery not found", 404);
      if (!(await isClientAuthed(req, client.slug))) return bad("Please sign in", 401);
      const state = await getState(client);
      const metas = await fileMetas(client.slug);
      const files: any[] = [];
      const used = new Set<string>();
      for (const item of client.items) {
        const meta = metas[item.id];
        if (!state.purchased[item.id] || !meta) continue;
        let name = downloadName(client, item, meta.filename);
        for (let n = 2; used.has(name.toLowerCase()); n++) name = name.replace(/( \(\d+\))?(\.\w+)$/, ` (${n})$2`);
        used.add(name.toLowerCase());
        const link = meta.storage === "r2" && r2()
          ? await r2Presign("GET", r2Key(client.slug, item.id), 6 * 3600)
          : `/dl/${encodeURIComponent(client.slug)}/${encodeURIComponent(item.id)}`;
        files.push({ id: item.id, name, size: meta.size || null, url: link });
      }
      return json({ zipName: zipName(client), files });
    }

    if (route === "confirm" && m === "GET") {
      const slug = url.searchParams.get("slug")!;
      const client = getClient(slug);
      const order = client && (await getOrder(slug, url.searchParams.get("order")!));
      const sid = url.searchParams.get("session_id");
      if (!client || !order || !sid || order.stripeSessionId !== sid) return Response.redirect(`${siteUrl(req)}/g/${slug}?error=1`, 302);
      const session = await stripe("GET", `checkout/sessions/${sid}`);
      if (session.payment_status === "paid" && session.metadata?.orderId === order.id) {
        order.amountPaid = session.amount_total;
        order.customerEmail = session.customer_details?.email;
        await fulfillOrder(client, order, "stripe");
        return Response.redirect(`${siteUrl(req)}/g/${slug}?paid=1`, 302);
      }
      return Response.redirect(`${siteUrl(req)}/g/${slug}?pending=1`, 302);
    }

    if (route === "stripe-webhook" && m === "POST") {
      const raw = await req.text();
      const whSecret = Netlify.env.get("STRIPE_WEBHOOK_SECRET");
      if (!(await verifyStripeSignature(raw, req.headers.get("stripe-signature"), whSecret))) return bad("bad signature", 400);
      const evt = JSON.parse(raw);
      if (evt.type === "checkout.session.completed" || evt.type === "checkout.session.async_payment_succeeded") {
        const s = evt.data.object;
        const client = getClient(s.metadata?.slug);
        const order = client && (await getOrder(client.slug, s.metadata?.orderId));
        if (client && order && s.payment_status === "paid" && order.stripeSessionId === s.id) {
          order.amountPaid = s.amount_total;
          order.customerEmail = s.customer_details?.email;
          await fulfillOrder(client, order, "stripe");
        }
      }
      return json({ received: true });
    }

    // ---------------- admin endpoints ----------------
    if (route === "admin/login" && m === "POST") {
      const { password } = await readJson(req);
      if (!(await checkAdminPassword(password))) return bad("Wrong password", 401);
      return json({ ok: true }, { headers: { "set-cookie": setCookieHeader(cookieName("admin"), await signToken("admin", 14), 14) } });
    }

    if (route.startsWith("admin/")) {
      if (!(await isAdmin(req))) return bad("Admin sign-in required", 401);

      if (route === "admin/clients" && m === "GET") {
        return json({
          clients: listClients().map((c: any) => ({ slug: c.slug, clientName: c.clientName, eventName: c.eventName, items: c.items.length })),
          paymentsEnabled: !!stripeKey(),
          stripeMode: stripeKey()?.startsWith("sk_live") ? "live" : stripeKey() ? "test" : "off",
          storage: storageMode(),
        });
      }

      // ---- raw uploads: whole shoots go straight to Cloudflare R2 under raw/<project>/ ----
      if (route.startsWith("admin/raw/")) {
        if (!r2()) return bad("R2 storage isn't configured");
        const body: any = m === "POST" ? await readJson(req) : {};
        const project = projectName(url.searchParams.get("project") || body.project);
        if (route === "admin/raw/projects" && m === "GET") {
          const { folders } = await r2List("raw/", "/");
          const names = new Set([...folders.map((f: string) => f.slice(4).replace(/\/$/, "")), ...listClients().map((c: any) => c.slug)]);
          return json({ projects: [...names].sort() });
        }
        if (!project) return bad("Choose a project name first");
        const prefix = `raw/${project}/`;
        if (route === "admin/raw/list" && m === "GET") {
          const { files } = await r2List(prefix);
          return json({ project, files: files.map((f: any) => ({ ...f, path: f.key.slice(prefix.length) })) });
        }
        if (route === "admin/raw/url" && m === "GET") {
          const path = safePath(url.searchParams.get("path"));
          const name = path.split("/").pop()!.replace(/"/g, "");
          return json({ url: await r2Presign("GET", prefix + path, 3600, { "response-content-disposition": `attachment; filename="${name}"` }) });
        }
        const path = safePath(body.path);
        if (!path) return bad("Missing file name");
        const key = prefix + path;
        if (route === "admin/raw/start" && m === "POST") {
          const size = Number(body.size) || 0;
          const existing = await r2Head(key);
          if (existing && existing.size === size && !body.replace) return json({ key, done: true });
          if (existing && (body.replace || existing.size !== size)) {
            // raw/ has a 90-day delete lock (R2 bucket lock rule raw-uploads-90-days), so a file can't be replaced:
            // upload it beside the old one as "name (new copy N).ext"
            const dot = path.lastIndexOf("."), stem = dot > 0 ? path.slice(0, dot) : path, ext = dot > 0 ? path.slice(dot) : "";
            for (let n = 1; n < 50; n++) {
              const alt = `${stem} (new copy${n > 1 ? " " + n : ""})${ext}`;
              const there = await r2Head(prefix + alt);
              if (!there) return json({ renamed: alt });
              if (there.size === size) return json({ key: prefix + alt, done: true, renamed: alt });
            }
            return bad("Too many copies of this file already");
          }
          if (size <= 64 * 1024 * 1024) return json({ key, url: await r2Presign("PUT", key, 3600) });
          return json({ key, uploadId: await r2MultipartStart(key, body.type) });
        }
        if (route === "admin/raw/parts" && m === "POST") {
          const parts = await r2MultipartParts(key, String(body.uploadId || ""));
          if (!parts) return bad("That upload expired; it will start over", 410);
          return json({ parts });
        }
        if (route === "admin/raw/part-urls" && m === "POST") {
          const nums = (body.parts || []).map(Number).filter((n: number) => n >= 1 && n <= 10000).slice(0, 50);
          const urls: Record<number, string> = {};
          for (const n of nums) urls[n] = await r2PartUrl(key, String(body.uploadId), n);
          return json({ urls });
        }
        if (route === "admin/raw/complete" && m === "POST") {
          await r2MultipartComplete(key, String(body.uploadId), (body.parts || []).map((p: any) => ({ n: Number(p.n), etag: String(p.etag) })));
          const head = await r2Head(key);
          return json({ key, size: head?.size ?? null });
        }
        if (route === "admin/raw/abort" && m === "POST") {
          await r2MultipartAbort(key, String(body.uploadId || ""));
          return json({ ok: true });
        }
        return bad("Not found", 404);
      }

      // ---- projects ----
      if (route === "admin/projects" && m === "GET") {
        const raw = await rawProjectFolders();
        const projects = await Promise.all((await listProjects()).map((p: any) => projectSummary(p, raw)));
        return json({ projects, worker: await getWorker() });
      }
      if (route === "admin/project" && m === "GET") {
        const p = await getProject(projectName(url.searchParams.get("id")));
        if (!p) return bad("Project not found", 404);
        const summary = await projectSummary(p, await rawProjectFolders());
        return json({ project: { ...summary, accessCode: p.accessCode || null }, worker: await getWorker() });
      }
      if (route === "admin/project" && m === "POST") {
        const b: any = await readJson(req);
        const at = new Date().toISOString();
        let p: any;
        if (b.id) {
          p = await getProject(projectName(b.id));
          if (!p) return bad("Project not found", 404);
          if (b.send) { p.sentToClaudeAt = at; p.sentNote = str(b.sentNote, 2000); p.claudeState = { state: "waiting", text: "", at }; }
          else if (b.claude) {
            // tools/project.py: link the finished gallery and record its access code for Keri
            if (b.gallerySlug) { if (!getClient(b.gallerySlug)) return bad("That gallery isn't deployed yet"); p.gallerySlug = b.gallerySlug; }
            if (b.accessCode) p.accessCode = str(b.accessCode, 40);
            if (b.claudeNote) (p.claudeNotes ||= []).push({ text: str(b.claudeNote, 2000), at });
            // what Keri sees at the top of the project: waiting → working (with the current step) → ready, or problem
            const state = b.gallerySlug ? "ready" : CLAUDE_STATES.includes(b.state) ? b.state : null;
            if (state) p.claudeState = { state, text: str(b.stateText, 300), at };
            if (b.macAlerted) p.claudeState = { ...(p.claudeState || { state: "waiting" }), macAlertedAt: at };
          } else p = cleanProject(b, p);
        } else {
          const name = str(b.name, 120);
          if (!name) return bad("Give the project a name");
          let id = projectName(name) || "project", n = 2;
          while ((await getProject(id)) || (getClient(id) && b.gallerySlug !== id)) id = `${projectName(name)}-${n++}`;
          p = { ...cleanProject(b), id, createdAt: at, gallerySlug: b.gallerySlug && getClient(b.gallerySlug) ? b.gallerySlug : null };
        }
        await saveProject(p);
        return json({ project: { ...(await projectSummary(p, await rawProjectFolders())), accessCode: p.accessCode || null } });
      }
      if (route === "admin/worker" && m === "POST") {
        const b: any = await readJson(req);
        await setWorker({ rendered: (b.rendered || []).slice(0, 50).map((x: any) => str(x, 60)), error: str(b.error, 500), host: str(b.host, 60) });
        return json({ ok: true });
      }

      const slug = url.searchParams.get("slug") || "";
      const client = getClient(slug);
      if (!client) return bad("Unknown client", 404);

      if (route === "admin/state" && m === "GET") {
        const metas = await fileMetas(slug);
        const p = await galleryPayload(client);
        return json({ ...p, items: client.items.map((i: any) => ({ ...i, ready: !!metas[i.id] })), orders: await listOrders(slug), files: metas });
      }

      // ---- review studio ----
      if (route === "admin/review" && m === "GET") {
        const metas = await fileMetas(slug);
        const review = await getReview(slug);
        const flags: Record<string, any> = {};
        for (const i of client.items) flags[i.id] = { waiting: editWaiting(review.items[i.id]), note: noteWaiting(review.items[i.id]) };
        flags.reel = { waiting: reelWaiting(review.reel), note: noteWaiting(review.reel) };
        const project = (await listProjects()).find((p: any) => p.gallerySlug === slug);
        return json({
          client: publicClient(client), review, flags, worker: await getWorker(), project: project ? { id: project.id, name: project.name } : null,
          items: client.items.map((i: any) => ({ ...i, ready: !!metas[i.id] })),
        });
      }
      if (route === "admin/review" && m === "POST") {
        const b: any = await readJson(req);
        const review = await getReview(slug);
        const at = new Date().toISOString();
        const by = ["Claude", "Auto-editor"].includes(b.by) ? b.by : "Keri";
        const tool = by !== "Keri";
        const note = (n: any) => n && String(n.text || "").trim()
          ? { t: Number.isFinite(Number(n.t)) && n.t !== null ? Math.max(0, Number(n.t)) : null, text: String(n.text).trim().slice(0, 2000), by, at }
          : null;
        if (typeof b.published === "boolean") review.published = b.published;
        if (b.id) {
          const item = client.items.find((i: any) => i.id === b.id);
          if (!item) return bad("Unknown item");
          const r = review.items[b.id] ||= { status: "new", edit: null, notes: [], version: 0 };
          if (b.status !== undefined) {
            if (!REVIEW_STATUSES.includes(b.status)) return bad("Unknown status");
            r.status = b.status;
          }
          if (b.edit !== undefined) {
            r.edit = cleanEdit(b.edit, item);
            if (b.status === undefined && by === "Keri") r.status = r.edit ? "edits" : r.status;
          }
          const n = note(b.note);
          if (n) { r.notes.push(n); if (b.status === undefined && by === "Keri" && r.status !== "remove") r.status = "edits"; }
          if (Number.isInteger(b.deleteNote)) r.notes.splice(b.deleteNote, 1);
          if (Number.isInteger(b.version)) r.version = b.version;
          // tools/studio.py records which edit the delivered file now reflects
          if (tool && b.rendered !== undefined) r.rendered = b.rendered === null ? null : { edit: cleanEdit(b.rendered, item), at };
          r.updatedAt = at;
        }
        if (b.reel !== undefined || b.reelNote || b.reelStatus || b.reelRendered !== undefined) {
          const reel = review.reel ||= { status: "new", pieces: [], notes: [], version: 0 };
          if (b.reel) Object.assign(reel, cleanReel(b.reel, client), { status: by === "Keri" ? "edits" : reel.status });
          const n = note(b.reelNote);
          if (n) { reel.notes.push(n); if (by === "Keri") reel.status = "edits"; }
          if (b.reelStatus && REVIEW_STATUSES.includes(b.reelStatus)) reel.status = b.reelStatus;
          if (Number.isInteger(b.reelDeleteNote)) reel.notes.splice(b.reelDeleteNote, 1);
          if (Number.isInteger(b.reelVersion)) reel.version = b.reelVersion;
          if (tool && b.reelRendered !== undefined) reel.rendered = b.reelRendered === null ? null : { plan: cleanReel(b.reelRendered, client), at };
          reel.updatedAt = at;
        }
        await saveReview(slug, review);
        return json({ review });
      }

      // R2: browser uploads straight to Cloudflare with a short-lived signed URL.
      if (route === "admin/upload-url" && m === "POST") {
        if (!r2()) return bad("R2 storage isn't configured");
        const { id } = await readJson(req);
        if (!client.items.some((i: any) => i.id === id)) return bad("Unknown item id");
        return json({ url: await r2Presign("PUT", r2Key(slug, id), 3600) });
      }
      if (route === "admin/upload-done" && m === "POST") {
        if (!r2()) return bad("R2 storage isn't configured");
        const { id, name, type } = await readJson(req);
        if (!client.items.some((i: any) => i.id === id)) return bad("Unknown item id");
        const head = await r2Head(r2Key(slug, id));
        if (!head) return bad("Upload not found in storage; try again", 409);
        await fileStore().setJSON(`meta/${slug}/${id}`, {
          storage: "r2", size: head.size, filename: name || id,
          contentType: type || "application/octet-stream", uploadedAt: new Date().toISOString(),
        });
        return json({ ok: true, size: head.size });
      }

      if (route === "admin/upload" && m === "PUT") {
        const id = url.searchParams.get("id")!;
        const part = Number(url.searchParams.get("part"));
        const total = Number(url.searchParams.get("total"));
        if (!client.items.some((i: any) => i.id === id)) return bad("Unknown item id");
        if (!(part >= 0 && part < total && total < 100000)) return bad("Bad part numbers");
        const body = await req.arrayBuffer();
        if (body.byteLength > PART_SIZE) return bad(`Part too large (${body.byteLength} bytes)`);
        const store = fileStore();
        await store.set(`parts/${slug}/${id}/${String(part).padStart(5, "0")}`, body);
        if (part === total - 1) {
          // Only mark the file ready once every part is actually stored.
          const { blobs } = await store.list({ prefix: `parts/${slug}/${id}/` });
          const have = new Set(blobs.map((b: any) => b.key));
          for (let i = 0; i < total; i++) {
            if (!have.has(`parts/${slug}/${id}/${String(i).padStart(5, "0")}`)) return bad(`Part ${i + 1} of ${total} is missing; upload the file again`, 409);
          }
          await store.setJSON(`meta/${slug}/${id}`, {
            parts: total,
            size: Number(url.searchParams.get("size")) || null,
            filename: url.searchParams.get("name") || id,
            contentType: url.searchParams.get("type") || "application/octet-stream",
            uploadedAt: new Date().toISOString(),
          });
        }
        return json({ ok: true, part });
      }

      if (route === "admin/action" && m === "POST") {
        const { action, id } = await readJson(req);
        const state = await getState(client);
        const at = new Date().toISOString();
        if (action === "mark-package-paid") state.packagePaid = true;
        else if (action === "mark-package-unpaid") state.packagePaid = false;
        else if (action === "unlock" && id) state.purchased[id] = { kind: "comp", orderId: "admin", at };
        else if (action === "revoke" && id) delete state.purchased[id];
        else if (action === "mark-cart-paid") {
          // Client paid outside the site (PayPal, check): fulfill the current cart as a manual order.
          const q = quote(client, state);
          const order: any = { id: crypto.randomUUID(), slug, createdAt: at, status: "pending", lines: q.lines, total: q.total, assign: q.assign, upsells: q.upsells, packageIncluded: q.packageIncluded };
          await saveOrder(order);
          await fulfillOrder(client, order, "manual");
          return json({ ok: true });
        } else return bad("Unknown action");
        state.selected = state.selected.filter((x: string) => !state.purchased[x]);
        await saveState(client, state);
        return json({ ok: true });
      }
    }

    return bad("Not found", 404);
  } catch (err: any) {
    console.error(err);
    return bad(err?.message || "Server error", 500);
  }
};

export const config: Config = { path: "/api/*" };
