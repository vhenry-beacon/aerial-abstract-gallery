// Projects: the admin home (tiles, new project) and each project's page (quote, instructions, files, Claude).
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (c) => "$" + ((c || 0) / 100).toLocaleString("en-US");
  const fmtDate = (d) => (d ? new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");
  const ago = (iso) => {
    const m = Math.round((Date.now() - new Date(iso)) / 60000);
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
  };
  const STEPS = ["quote", "files", "claude", "reviewing", "published", "paid"];
  const LABEL = { quote: "Quote", files: "Files uploaded", claude: "With Claude", reviewing: "Keri reviewing", published: "Published", paid: "Paid" };
  const isHome = !!$("tiles");

  async function api(path, body) {
    const res = await fetch(path, { method: body ? "POST" : "GET", credentials: "same-origin", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    let b = {}; try { b = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, body: b };
  }
  function workerLine(w) {
    if (!w) return "Auto-editor hasn't run yet.";
    const stale = Date.now() - new Date(w.at) > 40 * 60000;
    return `Auto-editor last checked ${ago(w.at)}${stale ? " (Vernon's Mac may be asleep)" : ""}.`;
  }
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await api("/api/admin/login", { password: $("pw").value });
    if (!r.ok) { $("loginErr").textContent = r.body.error || "Sign-in failed"; return; }
    boot();
  });
  function showApp(signedIn) {
    $("login").classList.toggle("hidden", signedIn);
    $("app").classList.toggle("hidden", !signedIn);
  }

  // ================= home: project tiles =================
  async function bootHome() {
    const r = await api("/api/admin/projects");
    if (r.status === 401) return showApp(false);
    showApp(true);
    $("worker").textContent = workerLine(r.body.worker);
    $("tiles").innerHTML = `<button class="pj-tile pj-new" id="newTile" type="button"><span>+</span>New project</button>` +
      r.body.projects.map((p) => {
        const c = p.counts;
        const sub = [p.client?.name, fmtDate(p.event?.date)].filter(Boolean).join(" · ");
        const bits = c ? [`${c.approved}/${c.items} approved`, c.waiting ? `⏳ ${c.waiting} queued` : "", c.notes ? `💬 ${c.notes} note${c.notes === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ")
          : p.hasFiles ? "Files uploaded" : "No files yet";
        const initials = p.name.split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
        return `<a class="pj-tile" href="/admin/project/?id=${encodeURIComponent(p.id)}">
          <div class="pj-cover">${p.cover ? `<img src="${esc(p.cover)}" alt="">` : `<span>${esc(initials)}</span>`}
            <span class="pill pj-${p.status}">${esc(p.statusLabel)}</span></div>
          <div class="pj-meta"><b>${esc(p.name)}</b><span>${esc(sub)}</span><span class="st-muted">${esc(bits)}</span></div></a>`;
      }).join("");
    $("newTile").onclick = () => { $("newErr").textContent = ""; $("newDlg").showModal(); $("nName").focus(); };
  }
  if (isHome) {
    $("newCancel").onclick = () => $("newDlg").close();
    $("newForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const r = await api("/api/admin/project", { name: $("nName").value, client: { name: $("nClient").value }, event: { date: $("nDate").value } });
      if (!r.ok) { $("newErr").textContent = r.body.error || "Couldn't create the project"; return; }
      location.href = `/admin/project/?id=${encodeURIComponent(r.body.project.id)}`;
    });
  }

  // ================= one project =================
  const id = new URLSearchParams(location.search).get("id");
  let P = null, saved = null, uploader = null;
  const get = (o, k) => k.split(".").reduce((a, x) => (a == null ? a : a[x]), o);
  const set = (o, k, v) => { const ks = k.split("."); const last = ks.pop(); ks.reduce((a, x) => (a[x] ||= {}), o)[last] = v; };

  async function bootProject() {
    if (!id) { location.href = "/admin/"; return; }
    const r = await api(`/api/admin/project?id=${encodeURIComponent(id)}`);
    if (r.status === 401) return showApp(false);
    if (!r.ok) { document.querySelector(".wrap").insertAdjacentHTML("beforeend", `<p class="err">${esc(r.body.error)}</p>`); return; }
    showApp(true);
    P = r.body.project; saved = JSON.stringify(formData());
    fillForm(); renderHead(r.body.worker); renderClaude();
    saved = JSON.stringify(formData()); markDirty();
    if (!uploader) uploader = window.RawUploader({
      project: P.id, drop: $("drop"), pickFiles: $("pickFiles"), pickFolder: $("pickFolder"),
      list: $("upList"), overall: $("upOverall"), cloud: $("cloudFiles"), cloudSum: $("cloudSum"),
      onList: (files) => { if (files.length && !P.hasFiles) { P.hasFiles = true; refreshStatus(); } },
    });
    window.DriveCheck({ project: P.id, input: $("checkDrive"), out: $("checkOut"), reupload: uploader.add });
    // keep the Claude status card current while the page is open
    setInterval(() => { if (!document.hidden && JSON.stringify(formData()) === saved) refreshStatus(); }, 60000);
  }
  async function refreshStatus() {
    const r = await api(`/api/admin/project?id=${encodeURIComponent(id)}`);
    if (r.ok) { P = { ...P, ...r.body.project }; renderHead(r.body.worker); renderClaude(); }
  }

  let W = null; // last auto-editor check-in, shown in the Claude status card
  function renderHead(worker) {
    if (worker !== undefined) W = worker;
    document.title = `${P.name} · Aerial Abstract`;
    $("pjName").textContent = P.name;
    const g = P.gallerySlug;
    $("pjActions").innerHTML = g ? `<a class="btn small" href="/admin/studio/?client=${encodeURIComponent(g)}">Open review studio</a>
      <a class="btn ghost small" href="/g/${encodeURIComponent(g)}" target="_blank">Preview gallery ↗</a>
      <a class="btn ghost small" href="/admin/orders/?client=${encodeURIComponent(g)}">Orders &amp; payments</a>` : "";
    const at = STEPS.indexOf(P.status);
    $("steps").innerHTML = STEPS.map((s, k) => `<li class="${k < at ? "done" : k === at ? "now" : ""}">${LABEL[s]}</li>`).join("");
    const c = P.counts;
    const top = P.claudeState?.state === "ready" ? "" : claudeStatus(); // the Claude card is the first thing Keri sees
    $("banner").innerHTML = top + (c && (c.waiting || c.notes) ? `<div class="st-banner">
      ${c.waiting ? `<div><b>⏳ ${c.waiting} edit${c.waiting === 1 ? "" : "s"} queued</b> for the auto-editor. ${workerLine(worker)}</div>` : ""}
      ${c.notes ? `<div><b>💬 ${c.notes} note${c.notes === 1 ? "" : "s"} for Claude.</b> Tell Vernon, or ask Claude: “Keri left notes.”</div>` : ""}</div>` : "");
  }

  // quote form
  function fillForm() {
    for (const el of document.querySelectorAll("[data-k]")) {
      const v = get(P, el.dataset.k);
      el.value = el.hasAttribute("data-money") ? (v ? v / 100 : "") : el.type === "number" && !v ? "" : v ?? "";
    }
    renderAddons(P.quote?.addons || []);
  }
  function renderAddons(list) {
    $("addons").innerHTML = list.map((a, k) => `<div class="pj-addon" data-addon="${k}">
      <input class="field" data-a="name" placeholder="Add-on (e.g. Highlight reel)" value="${esc(a.name)}">
      <input class="field" data-a="price" type="number" min="0" step="1" placeholder="$" value="${a.price ? a.price / 100 : ""}">
      <input class="field" data-a="description" placeholder="What it includes" value="${esc(a.description)}">
      <button class="btn ghost small" data-delAddon="${k}" type="button" aria-label="Remove add-on">✕</button></div>`).join("");
  }
  function addonsFromForm() {
    return [...document.querySelectorAll(".pj-addon")].map((row) => ({
      name: row.querySelector('[data-a="name"]').value.trim(),
      price: Math.round(Number(row.querySelector('[data-a="price"]').value || 0) * 100),
      description: row.querySelector('[data-a="description"]').value.trim(),
    }));
  }
  function formData() {
    const d = { id: P.id };
    for (const el of document.querySelectorAll("[data-k]")) {
      const v = el.hasAttribute("data-money") ? Math.round(Number(el.value || 0) * 100) : el.type === "number" ? Number(el.value || 0) : el.value;
      set(d, el.dataset.k, v);
    }
    set(d, "quote.addons", addonsFromForm().filter((a) => a.name));
    return d;
  }
  function markDirty() {
    const changed = JSON.stringify(formData()) !== saved;
    $("dirty").innerHTML = changed ? `<span class="st-dirty">Unsaved changes</span>` : P.updatedAt ? `Saved ${ago(P.updatedAt)}` : "";
    $("save").disabled = !changed;
  }
  async function saveProject() {
    const r = await api("/api/admin/project", formData());
    if (!r.ok) { alert(r.body.error || "Couldn't save"); return false; }
    P = { ...P, ...r.body.project }; saved = JSON.stringify(formData());
    $("pjName").textContent = P.name; markDirty();
    return true;
  }
  if (!isHome) {
    document.addEventListener("input", (e) => { if (e.target.closest("[data-k], .pj-addon")) markDirty(); });
    $("addAddon").onclick = () => { renderAddons([...addonsFromForm(), { name: "", price: 0, description: "" }]); markDirty(); };
    $("addons").addEventListener("click", (e) => {
      const b = e.target.closest("[data-delAddon]"); if (!b) return;
      const list = addonsFromForm(); list.splice(Number(b.dataset.deladdon), 1); renderAddons(list); markDirty();
    });
    $("save").onclick = saveProject;
    window.addEventListener("beforeunload", (e) => { if (P && JSON.stringify(formData()) !== saved) { e.preventDefault(); e.returnValue = ""; } });
  }

  // Where the hand-off stands, in plain words, so Keri never has to ask Vernon.
  // Claude works in a session on Vernon's Mac; the Mac checks every 15 minutes and alerts Vernon about new requests.
  function claudeStatus() {
    const s = P.claudeState || (P.sentToClaudeAt ? { state: "waiting", at: P.sentToClaudeAt } : null);
    if (!s) return "";
    const macOff = !W || Date.now() - new Date(W.at) > 40 * 60000;
    const card = (icon, cls, title, body) => `<div class="pj-cstate ${cls}"><b>${icon} ${title}</b>${body}</div>`;
    if (s.state === "working") return card("🛠", "working", "Claude is working on this", `<p>${esc(s.text || "Cutting and editing your files.")} <span class="st-muted">(updated ${ago(s.at)})</span></p>
      <p class="st-muted st-small">${P.gallerySlug ? "When it's done, the new items appear in the review studio, marked not reviewed." : "When it's done, the gallery appears here and in the review studio."} Nothing for you to do yet.</p>`);
    if (s.state === "problem") return card("⚠️", "problem", "Claude needs you", `<p>${esc(s.text || "Claude has a question; see its note below.")}</p>
      <p class="st-muted st-small">Change the quote, instructions or files as needed, then press Send to Claude again.</p>`);
    if (s.state === "ready") return P.gallerySlug ? card("✅", "ready", "Ready for your review", `<p>Claude finished ${ago(s.at)}. Open the review studio to check each item.</p>`) : "";
    const waited = Date.now() - new Date(P.sentToClaudeAt || s.at);
    const alerted = s.macAlertedAt ? `Vernon's Mac alerted him ${ago(s.macAlertedAt)}.` : macOff
      ? `<b>Vernon's Mac hasn't checked in ${W ? "since " + new Date(W.at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "yet"}</b>, so it hasn't seen this. It needs to be on and awake.`
      : "Vernon's Mac will alert him within 15 minutes.";
    return card("⏳", "waiting", "Waiting for Claude to start", `<p>Sent ${ago(P.sentToClaudeAt || s.at)}. ${alerted}</p>
      <p class="st-muted st-small">Claude starts when Vernon opens it on his Mac. This card changes to "working" as soon as it does.</p>
      ${waited > 2 * 3600000 ? `<p><b>It's been over 2 hours.</b> Text Vernon: “Projects are waiting for Claude.”</p>` : ""}`);
  }

  // hand-off to Claude, and what came back
  function renderClaude() {
    const notes = (P.claudeNotes || []).map((n) => `<div class="st-note claude"><div class="who"><span>Claude · ${new Date(n.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span></div>${esc(n.text)}</div>`).join("");
    const gallery = P.gallerySlug ? `<p><b>Client gallery:</b> <a href="/g/${encodeURIComponent(P.gallerySlug)}" target="_blank">${esc(location.origin)}/g/${esc(P.gallerySlug)}</a>
      ${P.accessCode ? `<br><b>Access code:</b> <code>${esc(P.accessCode)}</code>` : ""}</p>
      <p class="st-muted st-small">Review everything in the studio and publish when it's ready. Then send the client the link and code.</p>` : "";
    $("claudeBox").innerHTML = `${P.claudeState?.state === "ready" ? claudeStatus() : ""}${gallery}${notes ? `<div class="st-notes">${notes}</div>` : ""}
      ${P.gallerySlug ? `<h3 class="pj-sub">Add to this gallery or ask for more</h3>
      <textarea class="field" id="sendNote" placeholder="e.g. Add the new uploads. Make 5 horizontal clips from the long landscape video, 10–15 seconds, sunset and crowd shots, same warm look."></textarea>
      <button class="btn" id="sendBtn" type="button">Send to Claude</button>
      <p class="st-muted st-small">Upload the new files above first. Claude adds only what's new: everything already in the gallery, with your approvals and edits, stays as it is.</p>`
      : `<textarea class="field" id="sendNote" placeholder="Anything else Claude should know (optional)"></textarea>
      <button class="btn" id="sendBtn" type="button">${P.sentToClaudeAt ? "Send to Claude again" : "Send to Claude"}</button>
      <p class="st-muted st-small">Claude reads the quote, the instructions and the files, then cuts the clips, edits the photos and builds the client gallery. The card above shows where it stands.</p>`}`;
    const b = $("sendBtn");
    if (b) b.onclick = async () => {
      if (JSON.stringify(formData()) !== saved && !(await saveProject())) return;
      if (!P.hasFiles && !confirm("No files are uploaded yet. Send to Claude anyway?")) return;
      if (P.gallerySlug && !$("sendNote").value.trim()) { alert("Tell Claude what to do, e.g. “Add the new uploads.”"); return; }
      const r = await api("/api/admin/project", { id: P.id, send: true, sentNote: $("sendNote").value });
      if (!r.ok) return alert(r.body.error || "Couldn't send");
      P = { ...P, ...r.body.project }; renderHead(); renderClaude();
    };
  }

  async function boot() { return isHome ? bootHome() : bootProject(); }
  boot();
})();
