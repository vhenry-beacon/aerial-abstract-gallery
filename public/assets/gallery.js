(() => {
  const slug = decodeURIComponent(location.pathname.split("/")[2] || "");
  const $ = (id) => document.getElementById(id);
  const money = (c) => "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: c % 100 ? 2 : 0 });
  let data = null;
  let tab = "all";
  let lbList = [];
  let lbIndex = 0;

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
    data = r.body;
    $("login").classList.add("hidden");
    $("app").classList.remove("hidden");
    renderStatic();
    render();
    handleReturnParams();
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
    $("howExtra").textContent = `Want more? Every pick beyond ${c.package.included} is ${money(c.extraPrice)}.`;
  }

  const items = () => data.items.filter((i) => !i.upsellOnly);
  const isOwned = (id) => !!data.state.purchased[id];
  const isPicked = (id) => data.state.selected.includes(id);

  function pickLabel(id) {
    const kind = data.quote.assign[id];
    if (isOwned(id)) return "Yours";
    if (!kind) return "";
    return kind === "included" ? "Included" : `+${money(data.client.extraPrice)}`;
  }

  function card(it) {
    const el = document.createElement("div");
    el.className = "card" + (isPicked(it.id) ? " sel" : "") + (isOwned(it.id) ? " owned" : "");
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
    } else {
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
    if (tab === "picked") return list.filter((i) => isPicked(i.id));
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
    const counts = { all: all.length, clips: clips.length, photos: photos.length, picked: st.selected.length, owned: Object.keys(st.purchased).length };
    document.querySelectorAll(".tab").forEach((t) => {
      const k = t.dataset.tab;
      t.setAttribute("aria-selected", String(k === tab));
      const base = { all: "Everything", clips: "Clips", photos: "Photos", picked: "My picks", owned: "My files" }[k];
      t.textContent = counts[k] ? `${base} (${counts[k]})` : base;
    });

    // upsell
    renderUpsell();

    // grids
    const showClips = tab === "all" || tab === "clips" || tab === "picked";
    const showPhotos = tab === "all" || tab === "photos" || tab === "picked";
    const vc = visible(clips), vp = visible(photos);
    $("clipsGrid").replaceChildren(...vc.map(card));
    $("photosGrid").replaceChildren(...vp.map(card));
    $("clipsCount").textContent = `${vc.length} clip${vc.length === 1 ? "" : "s"} · 9:16 vertical`;
    $("photosCount").textContent = `${vp.length} photo${vp.length === 1 ? "" : "s"}`;
    $("clipsSection").classList.toggle("hidden", tab === "owned" || !showClips || !vc.length);
    $("photosSection").classList.toggle("hidden", tab === "owned" || !showPhotos || !vp.length);
    $("ownedPanel").classList.toggle("hidden", tab !== "owned");
    if (tab === "owned") renderOwned();
    const empty = tab === "picked" && !st.selected.length;
    $("emptyMsg").classList.toggle("hidden", !empty);
    $("emptyMsg").textContent = empty ? "You haven't picked anything yet. Tap + on any clip or photo." : "";

    // bar
    const cartCount = q.cart.length + q.upsells.length;
    let sum;
    if (!st.packagePaid) sum = `<b>${money(q.total)}</b><br>${c.package.name} package${q.extraCount ? ` + ${q.extraCount} extra` : ""}${q.upsells.length ? " + reel" : ""} · ${q.cart.length} picked`;
    else if (cartCount) sum = q.total ? `<b>${money(q.total)}</b><br>${cartCount} new item${cartCount > 1 ? "s" : ""}` : `<b>${q.cart.length} free pick${q.cart.length > 1 ? "s" : ""}</b><br>still included in your package`;
    else sum = `<b>All set</b><br>Your files are under My files`;
    $("barSum").innerHTML = sum;
    const btn = $("checkoutBtn");
    btn.disabled = st.packagePaid && !cartCount;
    btn.textContent = st.packagePaid && cartCount && !q.total ? "Add to my files" : "Review & check out";
  }

  function renderUpsell() {
    const slot = $("upsellSlot");
    const u = (data.client.upsells || [])[0];
    if (!u || tab === "owned" || tab === "photos") { slot.innerHTML = ""; return; }
    const owned = isOwned(u.unlocks);
    const inCart = data.state.cartUpsells.includes(u.id);
    slot.innerHTML = `
      <div class="upsell">
        <video src="${u.preview}" poster="${u.poster || ""}" muted loop playsinline autoplay controlslist="nodownload"></video>
        <div>
          <div class="tag">${owned ? "Purchased" : "Add-on · sample preview"}</div>
          <h3>${u.name}</h3>
          <p>${u.description}</p>
          ${owned ? `<span style="color:var(--ink-2)">Your reel is under My files.</span>` :
            `<button class="btn ${inCart ? "ghost" : "gold"}" id="upsellBtn" type="button">${inCart ? "Remove reel" : `Add reel · ${money(u.price)}`}</button>`}
        </div>
      </div>`;
    const v = slot.querySelector("video");
    v.addEventListener("contextmenu", (e) => e.preventDefault());
    v.addEventListener("click", () => { v.muted = !v.muted; });
    const b = $("upsellBtn");
    if (b) b.addEventListener("click", () => toggleUpsell(u.id, !inCart));
  }

  function renderOwned() {
    const panel = $("ownedPanel");
    const ids = Object.keys(data.state.purchased);
    if (!ids.length) { panel.innerHTML = `<p class="empty">Nothing purchased yet. After checkout, your full-quality files show up here.</p>`; return; }
    const byId = Object.fromEntries(data.items.map((i) => [i.id, i]));
    const ready = ids.filter((id) => byId[id]?.ready);
    panel.innerHTML = `
      <div class="section-h"><h2>My files</h2><span>${ids.length} file${ids.length > 1 ? "s" : ""} · full resolution</span></div>
      ${ready.length > 1 ? `<button class="btn" id="dlAll" type="button" style="margin-bottom:16px">Download all (${ready.length})</button>` : ""}
      <div class="grid clips" id="ownedClips"></div>
      <div class="grid photos" id="ownedPhotos"></div>`;
    const owned = ids.map((id) => byId[id]).filter(Boolean);
    $("ownedClips").replaceChildren(...owned.filter((i) => i.type === "video" && !i.upsellOnly).map(card));
    $("ownedPhotos").replaceChildren(...owned.filter((i) => i.type === "photo").map(card));
    const reel = owned.find((i) => i.upsellOnly);
    if (reel) {
      const row = document.createElement("p");
      row.innerHTML = reel.ready
        ? `<a class="btn" href="/dl/${encodeURIComponent(slug)}/${encodeURIComponent(reel.id)}">Download ${reel.title}</a>`
        : `<span class="note" style="display:inline-block">${reel.title}: being finished now. It will appear here to download.</span>`;
      panel.insertBefore(row, $("ownedClips"));
    }
    const all = $("dlAll");
    if (all) all.addEventListener("click", async () => {
      all.disabled = true;
      for (const id of ready) {
        const a = document.createElement("a");
        a.href = `/dl/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`;
        a.download = "";
        document.body.appendChild(a); a.click(); a.remove();
        await new Promise((r) => setTimeout(r, 1200));
      }
      all.disabled = false;
    });
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
    if (r.ok) { data = r.body; render(); } else toast(r.body.error || "Couldn't update");
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
    lbList = (tab === "owned" ? data.items.filter((i) => isOwned(i.id) && !i.upsellOnly) : visible(items()));
    lbIndex = Math.max(0, lbList.findIndex((i) => i.id === id));
    $("lightbox").classList.add("open"); $("scrim").classList.add("open");
    renderLightbox();
  }
  function closeLightbox() { $("lightbox").classList.remove("open"); $("scrim").classList.remove("open"); $("lbStage").innerHTML = ""; }
  function renderLightbox() {
    const it = lbList[lbIndex]; if (!it) return;
    const stage = $("lbStage");
    stage.innerHTML = it.type === "video"
      ? `<video src="${it.preview}" poster="${it.poster || ""}" autoplay loop playsinline controls controlslist="nodownload noplaybackrate" disablepictureinpicture></video>`
      : `<img src="${it.preview}" alt="${it.title}">`;
    stage.firstElementChild.addEventListener("contextmenu", (e) => e.preventDefault());
    const b = $("lbPick");
    if (isOwned(it.id)) { b.textContent = "Yours: download in My files"; b.disabled = true; }
    else { b.disabled = false; b.textContent = isPicked(it.id) ? `✓ Picked (${pickLabel(it.id)}). Tap to remove` : "+ Add to picks"; }
  }
  $("lbPick").addEventListener("click", () => { const it = lbList[lbIndex]; if (it) toggle(it.id); });
  $("lbPrev").addEventListener("click", () => { lbIndex = (lbIndex - 1 + lbList.length) % lbList.length; renderLightbox(); });
  $("lbNext").addEventListener("click", () => { lbIndex = (lbIndex + 1) % lbList.length; renderLightbox(); });
  $("lbClose").addEventListener("click", closeLightbox);
  $("lightbox").addEventListener("click", (e) => { if (e.target.id === "lightbox") closeLightbox(); });
  document.addEventListener("keydown", (e) => {
    if (!lbOpen()) { if (e.key === "Escape") closeDrawers(); return; }
    if (e.key === "Escape") closeLightbox();
    if (e.key === "ArrowLeft") $("lbPrev").click();
    if (e.key === "ArrowRight") $("lbNext").click();
  });

  load();
})();
