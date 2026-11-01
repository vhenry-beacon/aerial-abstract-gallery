import type { Config, Context } from "@netlify/functions";
import {
  getClient, listClients, getState, saveState, quote, fulfillOrder, saveOrder, getOrder, listOrders,
  json, signToken, cookieName, setCookieHeader, isClientAuthed, isAdmin, checkAdminPassword, sha256Hex,
  fileStore, PART_SIZE, stripe, stripeKey, verifyStripeSignature, siteUrl,
} from "../../lib/core.mjs";

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

async function galleryPayload(client: any) {
  const state = await getState(client);
  const metas = await fileMetas(client.slug);
  return {
    client: publicClient(client),
    items: client.items.map((i: any) => ({
      id: i.id, type: i.type, title: i.title, preview: i.preview, poster: i.poster,
      duration: i.duration, orientation: i.orientation, upsellOnly: !!i.upsellOnly,
      ready: !!metas[i.id],
    })),
    state: { packagePaid: state.packagePaid, selected: state.selected, cartUpsells: state.cartUpsells, purchased: state.purchased },
    quote: quote(client, state),
    paymentsEnabled: !!stripeKey(),
  };
}

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
      return json(await galleryPayload(client));
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
        state.selected = state.selected.filter((x: string) => x !== id);
        if (on) state.selected.push(id);
      }
      await saveState(client, state);
      return json(await galleryPayload(client));
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
        return json({ claimed: true, ...(await galleryPayload(client)) });
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
        });
      }

      const slug = url.searchParams.get("slug") || "";
      const client = getClient(slug);
      if (!client) return bad("Unknown client", 404);

      if (route === "admin/state" && m === "GET") {
        const p = await galleryPayload(client);
        return json({ ...p, items: client.items.map((i: any) => ({ ...i, ready: p.items.find((x: any) => x.id === i.id)?.ready })), orders: await listOrders(slug), files: await fileMetas(slug) });
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
