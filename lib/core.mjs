// Shared logic for functions (Node) and edge functions (Deno). Web APIs only.
import { getStore } from "@netlify/blobs";
import { AwsClient } from "aws4fetch";
import registry from "./registry.generated.mjs";

export const STATE_STORE = "gallery-state";
export const FILE_STORE = "fullres";
export const PART_SIZE = 3.5 * 1024 * 1024; // 3.5 MB per stored chunk (safely under the 4.5 MB function body limit)

const env = (k) => (globalThis.Netlify?.env?.get?.(k) ?? globalThis.process?.env?.[k] ?? "");

export function getClient(slug) {
  return Object.prototype.hasOwnProperty.call(registry, slug) ? registry[slug] : null;
}
export function listClients() {
  return Object.values(registry);
}

// Friendly name for a delivered file: "Fall Festival Clip 1.mp4", "Fall Festival Aerial Photo 3.jpg",
// "Fall Festival Highlight Reel.mp4". The extension comes from the stored file name.
export function downloadName(client, item, storedName = "") {
  const ext = (String(storedName || item.fullFile || "").match(/\.[A-Za-z0-9]{2,5}$/) || [item.type === "video" ? ".mp4" : ".jpg"])[0].toLowerCase();
  const label = item.upsellOnly
    ? "Highlight Reel"
    : String(item.title || item.id).replace(/\b0+(\d)/g, "$1").replace(/\b[a-z]/g, (c) => c.toUpperCase());
  const event = String(client.eventName || "").trim();
  const name = label.toLowerCase().startsWith(event.toLowerCase()) ? label : `${event} ${label}`;
  return (name.replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").trim() || item.id) + ext;
}
export function zipName(client) {
  return `${String(client.eventName || client.clientName || "Gallery").replace(/[\\/:*?"<>|]+/g, "").trim()} - Aerial Abstract.zip`;
}

// ---------- crypto helpers ----------
const enc = new TextEncoder();
function b64url(buf) {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
export async function sha256Hex(text) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function secret() {
  const s = env("SESSION_SECRET");
  if (!s || s.length < 24) throw new Error("SESSION_SECRET env var is missing or too short");
  return s;
}

// token = "<scope>.<expiresMs>.<sig>"   scope = client slug, or "admin"
export async function signToken(scope, days = 30) {
  const exp = Date.now() + days * 864e5;
  return `${scope}.${exp}.${await hmac(secret(), `${scope}.${exp}`)}`;
}
export async function verifyToken(token, scope) {
  if (!token) return false;
  const [s, exp, sig] = token.split(".");
  if (s !== scope || !exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmac(secret(), `${s}.${exp}`));
}
export const cookieName = (scope) => `ag_${scope.replace(/[^a-z0-9-]/gi, "")}`;

export function readCookie(req, name) {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}
export function setCookieHeader(name, value, days = 30) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${days * 86400}; HttpOnly; Secure; SameSite=Lax`;
}
export async function isClientAuthed(req, slug) {
  return (await verifyToken(readCookie(req, cookieName(slug)), slug)) || (await isAdmin(req));
}
export async function isAdmin(req) {
  return verifyToken(readCookie(req, cookieName("admin")), "admin");
}
export async function checkAdminPassword(pw) {
  const want = env("ADMIN_PASSWORD");
  return !!want && typeof pw === "string" && safeEqual(await sha256Hex(pw), await sha256Hex(want));
}

// ---------- state ----------
const stateStore = () => getStore({ name: STATE_STORE, consistency: "strong" });
export const fileStore = () => getStore({ name: FILE_STORE, consistency: "strong" });

export function emptyState(client) {
  return {
    packagePaid: !!client.package?.paidOffline,
    selected: [],        // item ids picked but not yet purchased (the cart)
    cartUpsells: [],     // upsell ids in the cart
    purchased: {},       // id -> { kind: "included" | "extra" | "upsell", orderId, at }
    updatedAt: null,
  };
}
export async function getState(client) {
  const s = await stateStore().get(`state/${client.slug}`, { type: "json" });
  return s ? { ...emptyState(client), ...s } : emptyState(client);
}
export async function saveState(client, state) {
  state.updatedAt = new Date().toISOString();
  await stateStore().setJSON(`state/${client.slug}`, state);
}
export async function saveOrder(order) {
  await stateStore().setJSON(`orders/${order.slug}/${order.id}`, order);
}
export async function getOrder(slug, id) {
  return stateStore().get(`orders/${slug}/${id}`, { type: "json" });
}
export async function listOrders(slug) {
  const { blobs } = await stateStore().list({ prefix: `orders/${slug}/` });
  const out = [];
  for (const b of blobs) out.push(await stateStore().get(b.key, { type: "json" }));
  return out.filter(Boolean).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// ---------- pricing (always computed server-side from config) ----------
export function includedUsed(state) {
  return Object.values(state.purchased).filter((p) => p.kind === "included").length;
}
export function quote(client, state) {
  const itemIds = new Set(client.items.filter((i) => !i.upsellOnly).map((i) => i.id));
  const cart = state.selected.filter((id) => itemIds.has(id) && !state.purchased[id]);
  const included = client.package.included;
  const freeSlots = state.packagePaid ? Math.max(0, included - includedUsed(state)) : included;
  const freeCount = Math.min(freeSlots, cart.length);
  const extraCount = cart.length - freeCount;
  const assign = {};
  cart.forEach((id, i) => (assign[id] = i < freeCount ? "included" : "extra"));

  const lines = [];
  if (!state.packagePaid) {
    lines.push({ key: "package", name: `${client.package.name} package (${included} deliverables included)`, unit: client.package.price, qty: 1 });
  }
  if (extraCount > 0) lines.push({ key: "extra", name: "Additional deliverables", unit: client.extraPrice, qty: extraCount });
  const upsells = [];
  for (const uid of state.cartUpsells) {
    const u = (client.upsells || []).find((x) => x.id === uid);
    if (u && !state.purchased[u.unlocks]) {
      lines.push({ key: `upsell:${u.id}`, name: u.name, unit: u.price, qty: 1 });
      upsells.push(u.id);
    }
  }
  const total = lines.reduce((s, l) => s + l.unit * l.qty, 0);
  return { cart, assign, freeSlots, freeCount, extraCount, upsells, lines, total, packageIncluded: !state.packagePaid };
}

// Apply a paid order to state. Idempotent.
export async function fulfillOrder(client, order, via) {
  if (order.status === "paid" || order.status === "void") return order;  // void: cancelled by an admin reset; never fulfill
  const state = await getState(client);
  const at = new Date().toISOString();
  if (order.packageIncluded) state.packagePaid = true;
  for (const [id, kind] of Object.entries(order.assign || {})) {
    if (!state.purchased[id]) state.purchased[id] = { kind, orderId: order.id, at };
  }
  for (const uid of order.upsells || []) {
    const u = (client.upsells || []).find((x) => x.id === uid);
    if (u && !state.purchased[u.unlocks]) state.purchased[u.unlocks] = { kind: "upsell", orderId: order.id, at };
  }
  state.selected = state.selected.filter((id) => !state.purchased[id]);
  state.cartUpsells = state.cartUpsells.filter((uid) => !(order.upsells || []).includes(uid));
  await saveState(client, state);
  order.status = "paid";
  order.paidAt = at;
  order.paidVia = via;
  await saveOrder(order);
  return order;
}

export const json = (data, init = {}) =>
  new Response(JSON.stringify(data), { ...init, headers: { "content-type": "application/json", "cache-control": "no-store", ...(init.headers || {}) } });

export function siteUrl(req) {
  return env("URL") && !env("NETLIFY_DEV") ? env("URL") : new URL(req.url).origin;
}

// ---------- Stripe (REST, no SDK) ----------
export function stripeKey() {
  return env("STRIPE_SECRET_KEY");
}
function formEncode(obj, prefix = "", out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") formEncode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join("&");
}
export async function stripe(method, path, params) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: { Authorization: `Bearer ${stripeKey()}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params ? formEncode(params) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Stripe error ${res.status}`);
  return data;
}
export async function verifyStripeSignature(rawBody, header, whSecret) {
  if (!header || !whSecret) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const t = parts.t;
  const sigs = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - Number(t)) > 600) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(whSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${rawBody}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => safeEqual(s, hex));
}

// ---------- Cloudflare R2 (S3-compatible) for full-quality files ----------
// Used when all four R2_* env vars are set; otherwise files live in Netlify Blobs.
export function r2() {
  const account = env("R2_ACCOUNT_ID"), key = env("R2_ACCESS_KEY_ID"), sec = env("R2_SECRET_ACCESS_KEY"), bucket = env("R2_BUCKET");
  if (!account || !key || !sec || !bucket) return null;
  return {
    client: new AwsClient({ accessKeyId: key, secretAccessKey: sec, service: "s3", region: "auto" }),
    base: `https://${account}.r2.cloudflarestorage.com/${bucket}`,
  };
}
export const r2Key = (slug, id) => `full/${slug}/${id}`;
const objUrl = (c, key) => `${c.base}/${key.split("/").map(encodeURIComponent).join("/")}`;

// Presigned URL the browser can use directly (PUT to upload, GET to download).
export async function r2Presign(method, key, expiresSec = 900, query = {}) {
  const c = r2();
  const u = new URL(objUrl(c, key));
  u.searchParams.set("X-Amz-Expires", String(expiresSec));
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  const signed = await c.client.sign(new Request(u, { method }), { aws: { signQuery: true } });
  return signed.url;
}
export async function r2Head(key) {
  const c = r2();
  const res = await c.client.fetch(objUrl(c, key), { method: "HEAD" });
  return res.ok ? { size: Number(res.headers.get("content-length")) || null } : null;
}
export async function r2Delete(key) {
  const c = r2();
  const res = await c.client.fetch(objUrl(c, key), { method: "DELETE" });
  return res.ok;
}
export function storageMode() {
  return r2() ? "r2" : "blobs";
}

// Bucket listing (ListObjectsV2). Returns { files: [{key, size, modified}], folders: [prefix] }.
export async function r2List(prefix, delimiter = "") {
  const c = r2();
  const files = [], folders = [];
  let token = "";
  do {
    const u = new URL(c.base);
    u.searchParams.set("list-type", "2");
    u.searchParams.set("prefix", prefix);
    if (delimiter) u.searchParams.set("delimiter", delimiter);
    if (token) u.searchParams.set("continuation-token", token);
    const res = await c.client.fetch(u.toString());
    if (!res.ok) throw new Error(`Storage listing failed (${res.status})`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const tag = (t) => (m[1].match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1] || "";
      // etag = MD5 of the file, or for multipart uploads MD5 of the parts' MD5s + "-<parts>" (public/assets/drivecheck.js)
      files.push({ key: xmlText(tag("Key")), size: Number(tag("Size")), modified: tag("LastModified"), etag: xmlText(tag("ETag")).replace(/"/g, "") });
    }
    for (const m of xml.matchAll(/<CommonPrefixes><Prefix>([^<]*)<\/Prefix><\/CommonPrefixes>/g)) folders.push(xmlText(m[1]));
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xmlText((xml.match(/<NextContinuationToken>([^<]*)</) || [])[1] || "") : "";
  } while (token);
  return { files, folders };
}
const xmlText = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

// Multipart uploads for large raw files: the browser PUTs each part to a presigned URL.
export async function r2MultipartStart(key, contentType) {
  const c = r2();
  const res = await c.client.fetch(`${objUrl(c, key)}?uploads`, { method: "POST", headers: { "content-type": contentType || "application/octet-stream" } });
  const xml = await res.text();
  const id = (xml.match(/<UploadId>([^<]*)<\/UploadId>/) || [])[1];
  if (!res.ok || !id) throw new Error(`Couldn't start the upload (${res.status})`);
  return xmlText(id);
}
export function r2PartUrl(key, uploadId, partNumber, expiresSec = 3600) {
  return r2Presign("PUT", key, expiresSec, { partNumber: String(partNumber), uploadId });
}
export async function r2MultipartParts(key, uploadId) {
  const c = r2();
  const res = await c.client.fetch(`${objUrl(c, key)}?uploadId=${encodeURIComponent(uploadId)}`);
  if (!res.ok) return null; // upload expired or was finished
  const xml = await res.text();
  return [...xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)].map((m) => ({
    n: Number((m[1].match(/<PartNumber>(\d+)</) || [])[1]),
    etag: xmlText((m[1].match(/<ETag>([^<]*)</) || [])[1] || ""),
    size: Number((m[1].match(/<Size>(\d+)</) || [])[1]),
  }));
}
export async function r2MultipartComplete(key, uploadId, parts) {
  const c = r2();
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const body = `<CompleteMultipartUpload>${parts.sort((a, b) => a.n - b.n)
    .map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${esc(p.etag)}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
  const res = await c.client.fetch(`${objUrl(c, key)}?uploadId=${encodeURIComponent(uploadId)}`, { method: "POST", body });
  const xml = await res.text();
  if (!res.ok || /<Error>/.test(xml)) throw new Error(`Couldn't finish the upload: ${(xml.match(/<Message>([^<]*)</) || [])[1] || res.status}`);
}
export async function r2MultipartAbort(key, uploadId) {
  const c = r2();
  await c.client.fetch(`${objUrl(c, key)}?uploadId=${encodeURIComponent(uploadId)}`, { method: "DELETE" });
}

// ---------- review studio (Keri's approvals, notes and edit requests) ----------
// One document per gallery: { published, items: { [id]: ItemReview }, reel, updatedAt }
//   ItemReview = { status: "new"|"approved"|"edits"|"remove"|"revised", edit, notes: [{t, text, by, at}], version }
export const REVIEW_STATUSES = ["new", "approved", "edits", "remove", "revised"];
const studioStore = () => getStore({ name: "studio", consistency: "strong" });
export async function getReview(slug) {
  const r = await studioStore().get(`review/${slug}`, { type: "json" });
  return { published: false, items: {}, reel: null, updatedAt: null, ...(r || {}) };
}
export async function saveReview(slug, review) {
  review.updatedAt = new Date().toISOString();
  await studioStore().setJSON(`review/${slug}`, review);
}
// Has a saved edit request (or reel plan) not been rendered yet? Both sides are cleaned by the API the same way.
export function editWaiting(r) {
  return !!r && JSON.stringify(r.edit ?? null) !== JSON.stringify(r.rendered?.edit ?? null);
}
export const REEL_KEYS = ["pieces", "look", "title", "subtitle", "endcard", "transition", "music"];
export function reelWaiting(reel) {
  if (!reel) return false;
  const plan = Object.fromEntries(REEL_KEYS.map((k) => [k, reel[k] ?? null]));
  const done = reel.rendered?.plan ? Object.fromEntries(REEL_KEYS.map((k) => [k, reel.rendered.plan[k] ?? null])) : null;
  return JSON.stringify(plan) !== JSON.stringify(done);
}
// Keri wrote a note after Claude last answered: it needs Claude's judgment (the auto-editor's notes don't count).
export function noteWaiting(r) {
  if (!r?.notes?.length) return false;
  const last = (by) => r.notes.filter((n) => n.by === by).reduce((a, n) => (n.at > a ? n.at : a), "");
  const keri = last("Keri");
  return !!keri && keri > last("Claude");
}

// ---------- projects (Keri's jobs: quote, instructions, raw files, then a gallery) ----------
export const PROJECT_STATUSES = { quote: "Quote", files: "Files uploaded", claude: "With Claude", waiting: "Waiting for Claude", working: "Claude working", problem: "Needs you", reviewing: "Keri reviewing", published: "Published", paid: "Paid" };
export async function getProject(id) {
  return studioStore().get(`project/${id}`, { type: "json" });
}
export async function saveProject(p) {
  p.updatedAt = new Date().toISOString();
  await studioStore().setJSON(`project/${p.id}`, p);
}
export async function listProjects() {
  const { blobs } = await studioStore().list({ prefix: "project/" });
  const out = [];
  for (const b of blobs) { const p = await studioStore().get(b.key, { type: "json" }); if (p) out.push(p); }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
// Auto-editor heartbeat (tools/autorender.sh on Vernon's Mac).
export async function getWorker() {
  return (await studioStore().get("worker/heartbeat", { type: "json" })) || null;
}
export async function setWorker(info) {
  await studioStore().setJSON("worker/heartbeat", { ...info, at: new Date().toISOString() });
}

// What a client may see: nothing until published, then approved (or already-owned) items.
export function clientCanSee(item, review, state) {
  if (item.upsellOnly) return true;
  if (state?.purchased?.[item.id]) return true;
  return !!review.published && review.items[item.id]?.status === "approved";
}
