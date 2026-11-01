(() => {
  const $ = (id) => document.getElementById(id);
  const money = (c) => "$" + ((c || 0) / 100).toLocaleString("en-US");
  const PART = 3.5 * 1024 * 1024;
  let slug = null;
  let st = null;
  let storage = "blobs";

  async function api(path, opts = {}) {
    const res = await fetch(path, { credentials: "same-origin", headers: { "content-type": "application/json" }, ...opts });
    let body = {}; try { body = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, body };
  }
  const log = (m) => { $("log").textContent += m + "\n"; $("log").scrollTop = 1e9; };

  async function boot() {
    const r = await api("/api/admin/clients");
    if (r.status === 401) { $("login").classList.remove("hidden"); $("app").classList.add("hidden"); return; }
    $("login").classList.add("hidden"); $("app").classList.remove("hidden");
    storage = r.body.storage || "blobs";
    $("mode").innerHTML = `Stripe: <b>${r.body.stripeMode}</b> · Storage: <b>${storage === "r2" ? "Cloudflare R2" : "Netlify"}</b>`;
    $("client").innerHTML = r.body.clients.map((c) => `<option value="${c.slug}">${c.clientName} · ${c.eventName}</option>`).join("");
    slug = new URLSearchParams(location.search).get("client") || r.body.clients[0]?.slug;
    $("client").value = slug;
    refresh();
  }
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await api("/api/admin/login", { method: "POST", body: JSON.stringify({ password: $("pw").value }) });
    if (!r.ok) { $("loginErr").textContent = r.body.error || "Sign-in failed"; return; }
    boot();
  });
  $("client").addEventListener("change", () => { slug = $("client").value; refresh(); });

  async function refresh() {
    $("openGallery").href = `/g/${slug}`;
    const r = await api(`/api/admin/state?slug=${encodeURIComponent(slug)}`);
    if (!r.ok) { alert(r.body.error); return; }
    st = r.body;
    const s = st.state, c = st.client;
    const ready = st.items.filter((i) => i.ready).length;
    const paidTotal = st.orders.filter((o) => o.status === "paid").reduce((a, o) => a + (o.amountPaid ?? o.total ?? 0), 0);
    $("kpis").innerHTML = [
      [s.packagePaid ? "Paid" : "Unpaid", `${c.package.name} package · ${money(c.package.price)}`],
      [`${s.selected.length}`, "in client's cart (not yet paid)"],
      [`${Object.keys(s.purchased).length}`, "files unlocked for client"],
      [`${ready} / ${st.items.length}`, "full-quality files uploaded"],
      [money(paidTotal), "collected through the gallery"],
    ].map(([b, t]) => `<div class="kpi"><b>${b}</b><span>${t}</span></div>`).join("");

    $("items").innerHTML = `<tr><th></th><th>Item</th><th>Full-quality file</th><th>Client status</th><th></th></tr>` + st.items.map((i) => {
      const p = s.purchased[i.id];
      const status = p ? `<span class="pill ok">${p.kind}</span>` : s.selected.includes(i.id) ? `<span class="pill warn">in cart</span>` : "";
      const thumb = i.type === "video" ? (i.poster || "") : (i.preview || "");
      return `<tr>
        <td>${thumb ? `<img src="${thumb}">` : ""}</td>
        <td><b>${i.id}</b><br><span style="color:var(--ink-3)">${i.title}</span></td>
        <td>${i.ready ? `<span class="pill ok">uploaded</span> ${st.files[i.id]?.filename || ""}` : `<span class="pill">expects ${i.fullFile || i.id}</span>`}</td>
        <td>${status}</td>
        <td>${p ? `<button class="btn ghost small" data-revoke="${i.id}">Revoke</button>` : `<button class="btn ghost small" data-unlock="${i.id}">Give free</button>`}
            ${i.ready ? `<a class="btn ghost small" href="/dl/${slug}/${i.id}">Test download</a>` : ""}</td></tr>`;
    }).join("");

    $("orders").innerHTML = `<tr><th>Date</th><th>Status</th><th>Lines</th><th>Total</th><th>Paid via</th><th>Email</th></tr>` +
      (st.orders.length ? st.orders.map((o) => `<tr><td>${new Date(o.createdAt).toLocaleString()}</td><td><span class="pill ${o.status === "paid" ? "ok" : ""}">${o.status}</span></td>
        <td>${(o.lines || []).map((l) => `${l.name}${l.qty > 1 ? " × " + l.qty : ""}`).join("<br>") || "Included picks"}</td><td>${money(o.amountPaid ?? o.total)}</td><td>${o.paidVia || ""}</td><td>${o.customerEmail || ""}</td></tr>`).join("")
        : `<tr><td colspan="6" style="color:var(--ink-3)">No orders yet</td></tr>`);
  }

  document.addEventListener("click", async (e) => {
    const t = e.target;
    let body = null;
    if (t.dataset.unlock) body = { action: "unlock", id: t.dataset.unlock };
    else if (t.dataset.revoke) body = { action: "revoke", id: t.dataset.revoke };
    else if (t.dataset.action) {
      if (!confirm(`Run "${t.textContent}" for ${slug}?`)) return;
      body = { action: t.dataset.action };
    }
    if (!body) return;
    const r = await api(`/api/admin/action?slug=${encodeURIComponent(slug)}`, { method: "POST", body: JSON.stringify(body) });
    if (!r.ok) alert(r.body.error); else refresh();
  });

  // ---------- uploads ----------
  function matchItem(file) {
    const base = file.name.replace(/\.[^.]+$/, "").toLowerCase();
    return st.items.find((i) => (i.fullFile || "").toLowerCase() === file.name.toLowerCase()) || st.items.find((i) => i.id.toLowerCase() === base);
  }
  function putWithProgress(url, file, label) {
    return new Promise((resolve) => {
      const x = new XMLHttpRequest();
      let lastPct = -10;
      x.open("PUT", url);
      x.setRequestHeader("content-type", file.type || "application/octet-stream");
      x.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = Math.floor((e.loaded / e.total) * 100);
        if (pct >= lastPct + 25) { lastPct = pct; log(`     ${label} ${pct}%`); }
      };
      x.onload = () => resolve(x.status >= 200 && x.status < 300);
      x.onerror = () => resolve(false);
      x.send(file);
    });
  }
  async function uploadToR2(file, item) {
    const q = `slug=${encodeURIComponent(slug)}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const u = await api(`/api/admin/upload-url?${q}`, { method: "POST", body: JSON.stringify({ id: item.id }) });
      if (!u.ok) { log(`FAIL ${file.name}: ${u.body.error}`); return; }
      if (await putWithProgress(u.body.url, file, file.name)) {
        const d = await api(`/api/admin/upload-done?${q}`, { method: "POST", body: JSON.stringify({ id: item.id, name: file.name, type: file.type }) });
        if (d.ok) { log(`OK   ${file.name} → ${item.id} (${(file.size / 1048576).toFixed(1)} MB)`); return; }
      }
      log(`     retrying ${file.name}…`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    log(`FAIL ${file.name}: upload to Cloudflare didn't complete. Check the bucket's CORS policy.`);
  }
  async function uploadFile(file) {
    const item = matchItem(file);
    if (!item) { log(`SKIP ${file.name}: no gallery item with that name`); return; }
    if (storage === "r2") return uploadToR2(file, item);
    const total = Math.max(1, Math.ceil(file.size / PART));
    for (let p = 0; p < total; p++) {
      const chunk = file.slice(p * PART, Math.min(file.size, (p + 1) * PART));
      const q = new URLSearchParams({ slug, id: item.id, part: p, total, name: file.name, type: file.type || "application/octet-stream", size: file.size });
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        const res = await fetch(`/api/admin/upload?${q}`, { method: "PUT", body: chunk, credentials: "same-origin", headers: { "content-type": "application/octet-stream" } });
        ok = res.ok;
        if (!ok) await new Promise((r) => setTimeout(r, 1500));
      }
      if (!ok) { log(`FAIL ${file.name} at part ${p + 1}/${total}`); return; }
    }
    log(`OK   ${file.name} → ${item.id} (${(file.size / 1048576).toFixed(1)} MB)`);
  }
  // Files split for transport (clip-01.mp4.001, clip-01.mp4.002, …) are stitched back
  // together in the browser before uploading. Other files pass through unchanged.
  function joinSplitFiles(files) {
    const groups = {}, out = [];
    for (const f of files) {
      const m = f.name.match(/^(.*)\.(\d{3})$/);
      if (m) (groups[m[1]] ||= []).push(f);
      else if (!f.name.startsWith(".")) out.push(f);
    }
    for (const [name, parts] of Object.entries(groups)) {
      parts.sort((a, b) => a.name.localeCompare(b.name));
      const type = name.endsWith(".mp4") ? "video/mp4" : name.match(/\.jpe?g$/i) ? "image/jpeg" : "";
      out.push(new File(parts, name, { type }));
    }
    return out;
  }
  async function handleFiles(files) {
    const list = joinSplitFiles([...files]);
    log(`Uploading ${list.length} file(s)…`);
    for (let i = 0; i < list.length; i += 3) await Promise.all(list.slice(i, i + 3).map(uploadFile));
    log("Done.");
    refresh();
  }
  const drop = $("drop");
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); handleFiles(e.dataTransfer.files); });
  $("file").addEventListener("change", (e) => handleFiles(e.target.files));

  boot();
})();
