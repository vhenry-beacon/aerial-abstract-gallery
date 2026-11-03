(() => {
  const slug = decodeURIComponent(location.pathname.split("/")[2] || "");
  const $ = (id) => document.getElementById(id);
  const money = (c) => "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: c % 100 ? 2 : 0 });
  let data = null;
  let tab = "all";
  let lbList = [];
  let lbIndex = 0;
  let lbReel = null; // the add-on reel when the lightbox is showing it

  function toast(msg, ms = 4200) {
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, { credentials: "same-origin", headers: { "content-type": "application/json" }, ...opts });
    let body = {};
    try { body = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, body };
  }

  // ---------- load ----------
  async function load() {
    if (!slug) { document.body.innerHTML = "<p class='wrap'>Gallery not found.</p>"; return; }
    const r = await api(`/api/gallery?slug=${encodeURIComponent(slug)}`);
    if (r.status === 401 && r.body.needsLogin) return showLogin(r.body.client);
    if (!r.ok) { document.body.innerHTML = `<p class='wrap' style='padding:40px 16px'>${r.body.error || "Gallery unavailable."}</p>`; return; }
    if (r.body.notPublished) return showNotPublished(r.body.client);
    data = r.body;
    $("login").classList.add("hidden");
    $("app").classList.remove("hidden");
    renderStatic();
    renderPreviewBanner();
    render();
    handleReturnParams();
  }

  // Keri hasn't published yet: the code works, but the gallery is still being finished.
  function showNotPublished(c) {
    showLogin(c);
    const p = c.provider || {};
    $("loginForm").innerHTML = `<div class="brand">${c.clientName}</div><h1>${c.eventName}</h1>
      <p style="color:var(--ink-2)">Your gallery is being finished. ${p.person || "We"} will let you know as soon as it's ready.</p>
      ${p.email ? `<p style="color:var(--ink-3);font-size:14px">Questions? <a href="mailto:${p.email}">${p.email}</a></p>` : ""}`;
  }

  // Signed in as admin: show what the client will see, and what's still hidden.
  function renderPreviewBanner() {
    const a = data.adminPreview;
    if (!a || $("previewBanner")) return;
    const b = document.createElement("div");
    b.id = "previewBanner";
    b.className = "preview-banner";
    b.innerHTML = `<b>Admin preview.</b> ${a.published ? "This gallery is published." : "Not published yet: the client sees a “being finished” page."}
      Only approved items are shown${a.hidden ? ` (${a.hidden} not approved yet)` : ""}. <a href="/admin/studio/?client=${encodeURIComponent(slug)}">Open the review studio</a>`;
    $("app").prepend(b);
  }

  function showLogin(c) {
    $("login").classList.remove("hidden");
    if (c) {
      $("loginTitle").textContent = c.eventName;
      $("loginEyebrow").textContent = c.clientName;
      document.title = `${c.eventName} · ${c.clientName}`;
    }
    $("code").focus();
  }

  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("loginErr").textContent = "";
    const r = await api("/api/login", { method: "POST", body: JSON.stringify({ slug, code: $("code").value }) });
    if (!r.ok) { $("loginErr").textContent = r.body.error || "Sign-in failed"; return; }
    load();
  });

  function handleReturnParams() {
    const p = new URLSearchParams(location.search);
    if (p.has("paid")) { toast("Payment received. Your files are unlocked under My files."); setTab("owned"); }
    else if (p.has("canceled")) toast("Checkout canceled. Your picks are saved.");
    else if (p.has("pending")) toast("Your payment is processing. Refresh in a minute.");
    else if (p.has("error")) toast("Something went wrong confirming payment. Contact us and we'll sort it out.");
    if ([...p.keys()].length) history.replaceState(null, "", location.pathname);
  }

  // ---------- render ----------
  function renderStatic() {
    const c = data.client;
    document.title = `${c.eventName} · ${c.clientName}`;
    $("eyebrow").textContent = `${c.clientName} · ${new Date(c.eventDate + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`;
    $("title").textContent = c.eventName;
    $("welcome").textContent = c.welcome || "";
    $("contact").innerHTML = `${c.provider.person}<br><a href="mailto:${c.provider.email}">${c.provider.email}</a>`;
    $("footer").innerHTML = `Questions? ${c.provider.person} · <a href="mailto:${c.provider.email}">${c.provider.email}</a> · ${c.provider.phone}<br>Previews are watermarked and reduced in size. Purchased files are full resolution with no watermark. Usage terms are in your service agreement. Credit ${c.provider.instagram} when you post. We appreciate it.`;
    $("howIncluded").textContent = `Your ${c.package.name} package includes ${c.package.included} deliverables, any mix of clips and photos.`;
    const reelPrices = [...new Set((c.upsells || []).map((u) => u.price))].sort((a, b) => a - b);
    $("howExtra").textContent = `Want more? Every photo or video beyond ${c.package.included} is ${money(c.extraPrice)}.` +
      (reelPrices.length ? ` Highlight reels are add-ons: ${reelPrices.length === 1 ? `${money(reelPrices[0])} each` : `from ${money(reelPrices[0])}`}.` : "");
  }

  const ordered = Sections.sort;
  const items = () => ordered(data.items.filter((i) => !i.upsellOnly));
  // fill Videos or Pictures with one grid per section (Sections.js); a subheading only when there's more than one
  function fillGroups(box, list) {
    const gs = Sections.groups(list);
    box.replaceChildren(...gs.flatMap((g) => {
      const grid = document.createElement("div");
      grid.className = `grid ${g.key.startsWith("video") ? (g.vertical ? "clips" : "wide") : g.vertical ? "photos tall" : "photos"}`;
      grid.replaceChildren(...g.items.map(card));
      if (gs.length < 2) return [grid];
      const h = document.createElement("div");
      h.className = "sub-h";
      h.innerHTML = `<b>${g.label}</b><span>${g.items.length}</span>`;
      return [h, grid];
    }));
  }
  const isOwned = (id) => !!data.state.purchased[id];
  const isPicked = (id) => data.state.selected.includes(id);
  const isComp = (id) => (data.quote.comp || []).includes(id);  // Keri's gift: already in the basket, free, outside the picks

  function pickLabel(id) {
    const kind = data.quote.assign[id];
    if (isOwned(id)) return "Yours";
    if (!kind) return "";
    if (kind === "comp") return "🎁 Complimentary";
    return kind === "included" ? "Included" : `+${money(data.client.extraPrice)}`;
  }

  function card(it) {
    const el = document.createElement("div");
    el.className = "card" + (isPicked(it.id) || isComp(it.id) ? " sel" : "") + (isOwned(it.id) ? " owned" : "") + (isComp(it.id) ? " comp" : "");
    let media;
    if (it.type === "video") {
      media = document.createElement("video");
      media.src = it.preview;
      media.poster = it.poster || "";
      media.muted = true; media.loop = true; media.playsInline = true; media.preload = "none";
      media.setAttribute("controlslist", "nodownload");
      el.addEventListener("mouseenter", () => media.play().catch(() => {}));
      el.addEventListener("mouseleave", () => media.pause());
    } else {
      media = document.createElement("img");
      media.src = it.preview; media.loading = "lazy"; media.alt = it.title;
    }
    media.className = "media";
    media.addEventListener("contextmenu", (e) => e.preventDefault());
    media.addEventListener("click", () => openLightbox(it.id));
    el.appendChild(media);

    const label = pickLabel(it.id);
    if (label) { const b = document.createElement("span"); b.className = "badge"; b.textContent = label; el.appendChild(b); }

    if (isOwned(it.id)) {
      const a = document.createElement(it.ready ? "a" : "span");
      a.className = "dl" + (it.ready ? "" : " wait");
      a.textContent = it.ready ? "Download" : "Preparing…";
      if (it.ready) a.href = `/dl/${encodeURIComponent(slug)}/${encodeURIComponent(it.id)}`;
      el.appendChild(a);
    } else if (!isComp(it.id)) {
      const p = document.createElement("button");
      p.className = "pick"; p.type = "button";
      p.setAttribute("aria-label", isPicked(it.id) ? "Remove from picks" : "Add to picks");
      p.innerHTML = isPicked(it.id) ? "✓" : "+";
      p.addEventListener("click", (e) => { e.stopPropagation(); toggle(it.id); });
      el.appendChild(p);
    }
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = `<span>${it.title}</span><span>${it.duration ? Math.round(it.duration) + "s" : ""}</span>`;
    el.appendChild(meta);
    return el;
  }

  function visible(list) {
    if (tab === "picked") return list.filter((i) => isPicked(i.id) || isComp(i.id));
    return list;
  }

  function render() {
    const c = data.client, q = data.quote, st = data.state;
    const all = items();
    const clips = all.filter((i) => i.type === "video");
    const photos = all.filter((i) => i.type === "photo");
    const ownedIncluded = Object.values(st.purchased).filter((p) => p.kind === "included").length;
    const pickedIncluded = q.freeCount;
    const used = (st.packagePaid ? ownedIncluded : 0) + pickedIncluded;

    // progress
    $("countText").innerHTML = st.packagePaid && q.freeSlots === 0
      ? `<b>${Object.keys(st.purchased).length}</b> files are yours · extra picks ${money(c.extraPrice)} each`
      : `<b>${used} of ${c.package.included}</b> included picks used${q.extraCount ? ` · <b>${q.extraCount}</b> extra at ${money(c.extraPrice)}` : ""}`;
    const pct = Math.min(100, (used / c.package.included) * 100);
    $("meter").firstElementChild.style.width = pct + "%";
    $("meter").classList.toggle("over", q.extraCount > 0);

    // tabs
    const ups = c.upsells || [];
    const counts = { all: all.length, clips: clips.length, photos: photos.length, picked: st.selected.length + q.comp.length, owned: Object.keys(st.purchased).length, addons: ups.length };
    document.querySelectorAll(".tab").forEach((t) => {
      const k = t.dataset.tab;
      t.setAttribute("aria-selected", String(k === tab));
      const base = { all: "Everything", clips: "Videos", photos: "Pictures", picked: "My picks", owned: "My files", addons: "Highlight Reels" }[k];
      if (k === "addons") t.classList.toggle("hidden", !ups.length);
      t.textContent = counts[k] ? `${base} (${counts[k]})` : base;
    });

    // upsell
    renderUpsell();

    // grids
    const showClips = tab === "all" || tab === "clips" || tab === "picked";  // the Add-ons tab shows only the add-ons
    const showPhotos = tab === "all" || tab === "photos" || tab === "picked";
    const vc = visible(clips), vp = visible(photos);
    fillGroups($("clipsGrid"), vc);
    fillGroups($("photosGrid"), vp);
    $("clipsCount").textContent = `${vc.length} video${vc.length === 1 ? "" : "s"}`;
    $("photosCount").textContent = `${vp.length} picture${vp.length === 1 ? "" : "s"}`;
    $("clipsSection").classList.toggle("hidden", tab === "owned" || !showClips || !vc.length);
    $("photosSection").classList.toggle("hidden", tab === "owned" || !showPhotos || !vp.length);
    $("ownedPanel").classList.toggle("hidden", tab !== "owned");
    if (tab === "owned") renderOwned();
    const empty = tab === "picked" && !st.selected.length && !q.comp.length;
    $("emptyMsg").classList.toggle("hidden", !empty);
    $("emptyMsg").textContent = empty ? "You haven't picked anything yet. Tap + on any clip or photo." : "";

    // bar
    const cartCount = q.cart.length + q.comp.length + q.upsells.length;
    const gifts = q.comp.length ? ` + ${q.comp.length} complimentary` : "";
    let sum;
    if (!st.packagePaid) sum = `<b>${money(q.total)}</b><br>${c.package.name} package${q.extraCount ? ` + ${q.extraCount} extra` : ""}${q.upsells.length ? ` + ${q.upsells.length} reel${q.upsells.length > 1 ? "s" : ""}` : ""} · ${q.cart.length} picked${gifts}`;
    else if (cartCount) sum = q.total ? `<b>${money(q.total)}</b><br>${cartCount} new item${cartCount > 1 ? "s" : ""}${gifts}`
      : `<b>${cartCount} free item${cartCount > 1 ? "s" : ""}</b><br>${q.cart.length ? "included in your package" : ""}${q.cart.length && q.comp.length ? " · " : ""}${q.comp.length ? "complimentary from Keri" : ""}`;
    else sum = `<b>All set</b><br>Your files are under My files`;
    $("barSum").innerHTML = sum;
    const btn = $("checkoutBtn");
    btn.disabled = st.packagePaid && !cartCount;
    btn.textContent = st.packagePaid && cartCount && !q.total ? "Add to my files" : "Review & check out";
  }

  // Add-ons: the highlight reels Keri approved and priced, grouped (Website & YouTube, Social media)
  function renderUpsell() {
    const slot = $("upsellSlot");
    const ups = data.client.upsells || [];
    if (!ups.length || !(tab === "all" || tab === "clips" || tab === "addons")) { slot.innerHTML = ""; return; }
    const groups = [];
    for (const u of ups) {
      const g = u.group || "Highlight reel";
      (groups.find((x) => x.g === g) || (groups.push({ g, list: [] }), groups.at(-1))).list.push(u);
    }
    const card = (u) => {
      const owned = isOwned(u.unlocks), inCart = data.state.cartUpsells.includes(u.id);
      return `<div class="reel-card ${u.orientation === "landscape" ? "wide" : ""}">
        <button class="reel-thumb" data-watch="${u.id}" type="button" aria-label="Watch ${u.name}">
          <video src="${u.preview}" poster="${u.poster || ""}" muted loop playsinline preload="none" controlslist="nodownload"></video>
          <span class="play">▶</span>
        </button>
        <div class="reel-info">
          <div class="tag">${owned ? "Purchased" : inCart ? "In your basket" : "Add-on"}</div>
          <b>${u.name}</b>
          <p>${u.description}</p>
          ${owned ? `<span class="reel-owned">Yours: under My files</span>` :
            `<button class="btn small ${inCart ? "ghost" : "gold"}" data-up="${u.id}" type="button">${inCart ? "Remove" : `Add · ${money(u.price)}`}</button>`}
        </div>
      </div>`;
    };
    slot.innerHTML = `<section class="reels">
      <div class="reels-head"><div class="tag">Add-ons</div><h3>Highlight reels</h3>
        <p>Edited reels of your event's best moments. Watch a preview, then add any of them to your order.</p></div>
      ${groups.map((x) => `<div class="reel-group">${groups.length > 1 || x.g !== "Highlight reel" ? `<h4>${x.g}</h4>` : ""}
        <div class="reel-grid">${x.list.map(card).join("")}</div></div>`).join("")}
    </section>`;
    for (const v of slot.querySelectorAll("video")) {
      v.addEventListener("contextmenu", (e) => e.preventDefault());
      const box = v.closest(".reel-card");
      box.addEventListener("mouseenter", () => v.play().catch(() => {}));
      box.addEventListener("mouseleave", () => v.pause());
    }
    const byId = (id) => ups.find((u) => u.id === id);
    for (const b of slot.querySelectorAll("[data-watch]")) b.addEventListener("click", () => openReel(byId(b.dataset.watch)));
    for (const b of slot.querySelectorAll("[data-up]")) b.addEventListener("click", () => toggleUpsell(b.dataset.up, !data.state.cartUpsells.includes(b.dataset.up)));
  }
  function renderOwned() {
    const panel = $("ownedPanel");
    const ids = Object.keys(data.state.purchased);
    if (!ids.length) { panel.innerHTML = `<p class="empty">Nothing purchased yet. After checkout, your full-quality files show up here.</p>`; return; }
    const byId = Object.fromEntries(data.items.map((i) => [i.id, i]));
    const ready = ids.filter((id) => byId[id]?.ready);
    panel.innerHTML = `
      <div class="section-h"><h2>My files</h2><span>${ids.length} file${ids.length > 1 ? "s" : ""} · full resolution</span></div>
      ${ready.length > 1 ? `<button class="btn" id="dlAll" type="button" style="margin-bottom:16px">Download all as one zip (${ready.length} files)</button>` : ""}
      <div id="ownedClips"></div>
      <div id="ownedPhotos"></div>`;
    const owned = ordered(ids.map((id) => byId[id]).filter(Boolean));
    fillGroups($("ownedClips"), owned.filter((i) => i.type === "video" && !i.upsellOnly));
    fillGroups($("ownedPhotos"), owned.filter((i) => i.type === "photo"));
    for (const reel of owned.filter((i) => i.upsellOnly)) {
      const row = document.createElement("p");
      row.innerHTML = reel.ready
        ? `<a class="btn" href="/dl/${encodeURIComponent(slug)}/${encodeURIComponent(reel.id)}">Download ${reel.title}</a>`
        : `<span class="note" style="display:inline-block">${reel.title}: being finished now. It will appear here to download.</span>`;
      panel.insertBefore(row, $("ownedClips"));
    }
    const all = $("dlAll");
    if (all) all.addEventListener("click", () => downloadAll(all, ready));
  }

  // "Download all": one zip, built in the browser by /zip-sw.js as it downloads. Browsers without
  // service workers fall back to one file at a time.
  async function downloadAll(btn, ready) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Getting your files ready…";
    try {
      const list = await api(`/api/download-list?slug=${encodeURIComponent(slug)}`);
      if (!list.ok || !list.body.files?.length) throw new Error(list.body.error || "No files to download yet.");
      const mb = list.body.files.reduce((t, f) => t + (f.size || 0), 0) / 1e6;
      const size = mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.max(1, Math.round(mb))} MB`;
      if (await zipWorkerReady()) {
        openHidden(`/zip/${encodeURIComponent(slug)}/${encodeURIComponent(list.body.zipName)}`);
        toast(`Downloading one zip file (${list.body.files.length} files, ${size}). Your browser shows the progress; keep this page open until it finishes.`, 10000);
      } else {
        toast(`Starting ${ready.length} downloads. If your browser asks to allow multiple downloads, choose Allow.`, 8000);
        for (const [n, id] of ready.entries()) {
          btn.textContent = `Starting ${n + 1} of ${ready.length}…`;
          openHidden(`/dl/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`);
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    } catch (err) {
      toast(err.message || "Couldn't start the download. Please try again.", 8000);
    }
    btn.textContent = label;
    btn.disabled = false;
  }

  // A hidden frame: the response is an attachment, so the browser saves it and the page stays put.
  function openHidden(src) {
    const f = document.createElement("iframe");
    f.hidden = true;
    f.src = src;
    document.body.appendChild(f);
    setTimeout(() => f.remove(), 120000);
  }

  async function zipWorkerReady() {
    if (!("serviceWorker" in navigator) || !window.ReadableStream) return false;
    try {
      const reg = await navigator.serviceWorker.register("/zip-sw.js", { scope: "/zip/" });
      const sw = reg.active || reg.waiting || reg.installing;
      if (!sw) return false;
      if (sw.state !== "activated") {
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("timeout")), 10000);
          sw.addEventListener("statechange", () => {
            if (sw.state === "activated") { clearTimeout(t); resolve(); }
            if (sw.state === "redundant") { clearTimeout(t); reject(new Error("redundant")); }
          });
        });
      }
      return true;
    } catch {
      return false;
    }
  }

  function setTab(t) { tab = t; render(); window.scrollTo({ top: $("tabs").offsetTop - 10, behavior: "smooth" }); }
  $("tabs").addEventListener("click", (e) => { const t = e.target.closest(".tab"); if (t) setTab(t.dataset.tab); });

  // ---------- actions ----------
  // Picks are queued so fast taps are never dropped; each save waits for the previous one.
  let queue = Promise.resolve();
  function toggle(id) {
    const on = !isPicked(id);
    data.state.selected = on ? [...data.state.selected, id] : data.state.selected.filter((x) => x !== id);
    render();
    if (lbOpen()) renderLightbox();
    queue = queue.then(async () => {
      const r = await api("/api/select", { method: "POST", body: JSON.stringify({ slug, id, on }) });
      if (!r.ok) toast(r.body.error || "Couldn't save that pick");
      return r;
    }).then((r) => {
      if (r.ok) {
        const local = data.state.selected;
        data = r.body;
        // keep any optimistic picks made while this request was in flight
        if (local.join() !== data.state.selected.join()) data.state.selected = local;
      }
      render();
      if (lbOpen()) renderLightbox();
    });
  }
  async function toggleUpsell(upsell, on) {
    const r = await api("/api/select", { method: "POST", body: JSON.stringify({ slug, upsell, on }) });
    if (r.ok) { data = r.body; render(); if (lbReel) reelPickLabel(); } else toast(r.body.error || "Couldn't update");
  }

  // ---------- checkout drawer ----------
  function openDrawer(el) { $("scrim").classList.add("open"); el.classList.add("open"); }
  function closeDrawers() { $("scrim").classList.remove("open"); $("drawer").classList.remove("open"); $("how").classList.remove("open"); }
  $("scrim").addEventListener("click", closeDrawers);
  $("drawerClose").addEventListener("click", closeDrawers);
  $("howBtn").addEventListener("click", () => openDrawer($("how")));
  $("howClose").addEventListener("click", closeDrawers);

  $("checkoutBtn").addEventListener("click", () => {
    const q = data.quote, c = data.client;
    $("lines").innerHTML = q.lines.map((l) => `<tr><td>${l.name}${l.qty > 1 ? ` × ${l.qty}` : ""}</td><td>${money(l.unit * l.qty)}</td></tr>`).join("")
      + (q.freeCount ? `<tr><td>${q.freeCount} included pick${q.freeCount > 1 ? "s" : ""}</td><td>Included</td></tr>` : "")
      + (q.comp.length ? `<tr><td>${q.comp.length} complimentary item${q.comp.length > 1 ? "s" : ""}, a gift from ${c.provider?.person?.split(" ")[0] || "us"}</td><td>Free</td></tr>` : "")
      + `<tr class="total"><td>Total</td><td>${money(q.total)}</td></tr>`;
    const note = $("drawerNote");
    const remaining = q.freeSlots - q.freeCount;
    if (remaining > 0) {
      note.textContent = `You still have ${remaining} included pick${remaining > 1 ? "s" : ""} left. You can check out now and pick the rest later at no extra cost.`;
      note.classList.remove("hidden");
    } else note.classList.add("hidden");
    $("payBtn").textContent = q.total ? `Pay ${money(q.total)}` : "Add to my files";
    $("email").classList.toggle("hidden", !q.total);
    $("checkoutErr").textContent = data.paymentsEnabled || !q.total ? "" : "Online payment is being set up. You can still review your order.";
    openDrawer($("drawer"));
  });

  $("payBtn").addEventListener("click", async () => {
    const btn = $("payBtn");
    btn.disabled = true; $("checkoutErr").textContent = "";
    const r = await api("/api/checkout", { method: "POST", body: JSON.stringify({ slug, email: $("email").value || undefined }) });
    btn.disabled = false;
    if (r.ok && r.body.url) { location.href = r.body.url; return; }
    if (r.ok && r.body.claimed) { data = r.body; closeDrawers(); toast("Added to My files."); setTab("owned"); return; }
    $("checkoutErr").textContent = r.body.error || "Checkout failed. Please try again.";
  });

  // ---------- lightbox ----------
  const lbOpen = () => $("lightbox").classList.contains("open");
  function openLightbox(id) {
    lbReel = null;
    lbList = (tab === "owned" ? items().filter((i) => isOwned(i.id)) : visible(items()));
    lbIndex = Math.max(0, lbList.findIndex((i) => i.id === id));
    $("lightbox").classList.add("open"); $("scrim").classList.add("open");
    renderLightbox();
  }
  function closeLightbox() {
    lbReel = null;
    $("lightbox").classList.remove("open", "reel"); $("scrim").classList.remove("open"); $("lbStage").innerHTML = "";
  }
  function renderLightbox() {
    const it = lbList[lbIndex]; if (!it) return;
    const stage = $("lbStage");
    stage.innerHTML = it.type === "video"
      ? `<video src="${it.preview}" poster="${it.poster || ""}" autoplay loop playsinline controls controlslist="nodownload noplaybackrate" disablepictureinpicture></video>`
      : `<img src="${it.preview}" alt="${it.title}">`;
    stage.firstElementChild.addEventListener("contextmenu", (e) => e.preventDefault());
    $("lbFull").classList.toggle("hidden", it.type !== "video");
    const b = $("lbPick");
    if (isOwned(it.id)) { b.textContent = "Yours: download in My files"; b.disabled = true; }
    else if (isComp(it.id)) { b.textContent = "🎁 Complimentary: already in your basket"; b.disabled = true; }
    else { b.disabled = false; b.textContent = isPicked(it.id) ? `✓ Picked (${pickLabel(it.id)}). Tap to remove` : "+ Add to picks"; }
  }

  // The add-on reel: full length, from the start, with sound and controls.
  function openReel(u) {
    lbReel = u;
    $("lightbox").classList.add("open", "reel"); $("scrim").classList.add("open");
    const stage = $("lbStage");
    stage.innerHTML = `<video src="${u.preview}" poster="${u.poster || ""}" autoplay playsinline controls controlslist="nodownload noplaybackrate" disablepictureinpicture></video>`;
    stage.firstElementChild.addEventListener("contextmenu", (e) => e.preventDefault());
    $("lbFull").classList.remove("hidden");
    reelPickLabel();
  }
  function reelPickLabel() {
    const u = lbReel, b = $("lbPick");
    if (isOwned(u.unlocks)) { b.textContent = "Yours: download in My files"; b.disabled = true; return; }
    b.disabled = false;
    b.textContent = data.state.cartUpsells.includes(u.id) ? "✓ In your basket. Tap to remove" : `Add this reel · ${money(u.price)}`;
  }
  function goFullscreen() {
    const v = $("lbStage").querySelector("video"); if (!v) return;
    if (v.requestFullscreen) v.requestFullscreen().catch(() => {});
    else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen(); // iPhone Safari
  }
  $("lbFull").addEventListener("click", goFullscreen);
  $("lbPick").addEventListener("click", () => {
    if (lbReel) return toggleUpsell(lbReel.id, !data.state.cartUpsells.includes(lbReel.id));
    const it = lbList[lbIndex]; if (it) toggle(it.id);
  });
  $("lbPrev").addEventListener("click", () => { lbIndex = (lbIndex - 1 + lbList.length) % lbList.length; renderLightbox(); });
  $("lbNext").addEventListener("click", () => { lbIndex = (lbIndex + 1) % lbList.length; renderLightbox(); });
  $("lbClose").addEventListener("click", closeLightbox);
  $("lightbox").addEventListener("click", (e) => { if (e.target.id === "lightbox") closeLightbox(); });
  document.addEventListener("keydown", (e) => {
    if (!lbOpen()) { if (e.key === "Escape") closeDrawers(); return; }
    if (e.key === "Escape") closeLightbox();
    if (lbReel) return;
    if (e.key === "ArrowLeft") $("lbPrev").click();
    if (e.key === "ArrowRight") $("lbNext").click();
  });

  load();
})();
