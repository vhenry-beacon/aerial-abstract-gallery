// Shared logic for functions (Node) and edge functions (Deno). Web APIs only.
import { getStore } from "@netlify/blobs";
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
  if (order.status === "paid") return order;
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
