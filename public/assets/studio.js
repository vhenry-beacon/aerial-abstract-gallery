// Review studio: Keri approves photos and clips, requests edits (look, speed, trim, notes),
// arranges the highlight reel, publishes the gallery, and uploads whole shoots to R2.
// Saved edits are requests: Claude renders the final files with tools/studio.py.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  const secs = (t) => `${(Math.round(t * 10) / 10).toFixed(1)}s`;
  const clone = (o) => JSON.parse(JSON.stringify(o ?? null));
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const STATUS = { new: "Not reviewed", edits: "Needs edits", revised: "Updated, check it", approved: "Approved", remove: "Removed" };
  const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2, 4];
  const XF = 0.4; // reel crossfade seconds, as in the final render

  let slug = null, D = null, tab = "items", filter = "all";
  let curId = null, draft = null;   // item being edited and its unsaved edit
  let rdraft = null, pieceIdx = -1; // unsaved reel plan and selected piece

  async function api(path, opts = {}) {
    const res = await fetch(path, { credentials: "same-origin", headers: { "content-type": "application/json" }, ...opts });
    let body = {}; try { body = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, body };
  }
  function toast(msg, ms = 3200) {
    const t = document.createElement("div");
    t.className = "toast"; t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), ms);
  }

  // ---------- sign-in and loading ----------
  async function boot() {
    const r = await api("/api/admin/clients");
    if (r.status === 401) { $("login").classList.remove("hidden"); $("app").classList.add("hidden"); return; }
    $("login").classList.add("hidden"); $("app").classList.remove("hidden");
    $("client").innerHTML = r.body.clients.map((c) => `<option value="${esc(c.slug)}">${esc(c.clientName)} · ${esc(c.eventName)}</option>`).join("");
    const q = new URLSearchParams(location.search);
    slug = q.get("client") || r.body.clients[0]?.slug;
    $("client").value = slug;
    setTab(q.get("tab") || "items");
    await load();
  }
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await api("/api/admin/login", { method: "POST", body: JSON.stringify({ password: $("pw").value }) });
    if (!r.ok) { $("loginErr").textContent = r.body.error || "Sign-in failed"; return; }
    boot();
  });
  $("client").addEventListener("change", () => {
    if (unsaved() && !confirm("You have unsaved changes. Switch galleries anyway?")) { $("client").value = slug; return; }
    slug = $("client").value; curId = null; draft = null; rdraft = null; load();
  });

  async function load() {
    const r = await api(`/api/admin/review?slug=${encodeURIComponent(slug)}`);
    if (!r.ok) { toast(r.body.error || "Couldn't load the gallery"); return; }
    D = r.body;
    $("previewLink").href = `/g/${encodeURIComponent(slug)}`;
    // the Highlight reels tab: the gallery's own reel (if it has one) and the highlight reel add-ons
    const anyReel = reelKeys().length > 0;
    document.querySelector('#stTabs [data-tab="reel"]').classList.toggle("hidden", !anyReel);
    if (tab === "reel" && !anyReel) setTab("items");
    if (!reelKeys().includes(reelKey)) { reelKey = reelKeys()[0] || "legacy"; rdraft = null; }
    renderPublish();
    renderItems();
    if (!rdraft) rdraft = reelFromReview();
    renderReel();
  }
  async function save(body, msg) {
    const r = await api(`/api/admin/review?slug=${encodeURIComponent(slug)}`, { method: "POST", body: JSON.stringify(body) });
    if (!r.ok) { toast(r.body.error || "Couldn't save"); return false; }
    D.review = r.body.review;
    if (msg) toast(msg);
    renderPublish();
    return true;
  }
  const unsaved = () => (curId && !same(draft, editOf(curId))) || (rdraft && !same(rdraft, reelFromReview()));
  window.addEventListener("beforeunload", (e) => { if (unsaved()) { e.preventDefault(); e.returnValue = ""; } });

  // ---------- tabs ----------
  function setTab(t) {
    tab = ["items", "reel"].includes(t) ? t : "items";
    for (const b of document.querySelectorAll("#stTabs .tab")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
    for (const k of ["items", "reel"]) $(`tab-${k}`).classList.toggle("hidden", k !== tab);
    if (tab !== "reel") stopReel();
  }
  $("stTabs").addEventListener("click", (e) => { const b = e.target.closest(".tab"); if (b) setTab(b.dataset.tab); });

  // ---------- publish ----------
  function ago(iso) {
    const m = Math.round((Date.now() - new Date(iso)) / 60000);
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
  }
  // Where Keri's requests stand: queued for the auto-editor, notes for Claude, updates to check.
  function renderBanner() {
    const items = D.items.filter((i) => !i.upsellOnly);
    const queued = items.filter((i) => editWaiting(D.review.items[i.id])).length + (reelWaiting(D.review.reel) ? 1 : 0)
      + Object.values(D.review.reels || {}).filter((rp) => reelWaiting(rp)).length;
    const notes = items.filter((i) => noteWaiting(D.review.items[i.id]) && rev(i.id).status !== "approved").length + (noteWaiting(D.review.reel) ? 1 : 0);
    const updated = items.filter((i) => rev(i.id).status === "revised").length + (D.review.reel?.status === "revised" ? 1 : 0);
    const w = D.worker, stale = !w || Date.now() - new Date(w.at) > 40 * 60000;
    const parts = [];
    if (queued) parts.push(`<b>⏳ ${queued} edit${queued === 1 ? "" : "s"} queued.</b> ${stale
      ? `The auto-editor hasn't checked in ${w ? `since ${ago(w.at)}` : "yet"}: Vernon's Mac may be asleep or off.`
      : "The auto-editor runs every 15 minutes while Vernon's Mac is on (slow motion takes a few minutes more)."}`);
    if (notes) parts.push(`<b>💬 ${notes} note${notes === 1 ? "" : "s"} for Claude.</b> Written notes need Claude: tell Vernon, or ask Claude: “Keri left notes.”`);
    if (updated) parts.push(`<b>✓ ${updated} updated</b>, ready for you to check. <button class="st-chip" data-f="revised" type="button">Show them</button>`);
    if (w?.error && !stale) parts.push(`<span class="err">The auto-editor hit a problem: ${esc(w.error.slice(0, 160))}</span>`);
    const proj = D.project ? `<a href="/admin/project/?id=${encodeURIComponent(D.project.id)}">${esc(D.project.name)} project page</a>` : "";
    $("banner").innerHTML = parts.length || proj ? `<div class="st-banner">${parts.map((x) => `<div>${x}</div>`).join("")}
      <div class="st-muted st-small">${w ? `Auto-editor last checked ${ago(w.at)}.` : ""} ${proj}</div></div>` : "";
    if (D.project) $("homeLink").href = `/admin/project/?id=${encodeURIComponent(D.project.id)}`, $("homeLink").textContent = "← Project page";
  }
  $("banner").addEventListener("click", (e) => { const b = e.target.closest("[data-f]"); if (b) { filter = b.dataset.f; setTab("items"); renderItems(); } });

  function renderPublish() {
    renderBanner();
    const items = D.items.filter((i) => !i.upsellOnly);
    const approved = items.filter((i) => rev(i.id).status === "approved").length;
    const pub = D.review.published;
    const gifts = items.filter((i) => rev(i.id).comp && rev(i.id).status === "approved").length;
    const giftText = gifts ? ` (${gifts} complimentary 🎁)` : "";
    $("pubText").innerHTML = pub
      ? `<span class="live">● Published</span> · client sees ${approved} approved item${approved === 1 ? "" : "s"}${giftText}`
      : `Not published · ${approved} of ${items.length} approved${giftText}`;
    $("pubBtn").textContent = pub ? "Unpublish" : "Publish gallery";
    $("pubBtn").className = `btn small ${pub ? "ghost" : ""}`;
  }
  $("pubBtn").addEventListener("click", async () => {
    const items = D.items.filter((i) => !i.upsellOnly);
    const approved = items.filter((i) => rev(i.id).status === "approved").length;
    if (!D.review.published) {
      if (!approved) return alert("Approve at least one photo or clip first. Only approved items are shown to the client.");
      if (!confirm(`Publish? The client will see the ${approved} approved item${approved === 1 ? "" : "s"}. The other ${items.length - approved} stay hidden until you approve them.`)) return;
    } else if (!confirm("Unpublish? The client will see a “being finished” page until you publish again.")) return;
    save({ published: !D.review.published }, D.review.published ? "Gallery unpublished" : "Gallery published");
  });

  // ================= photos & clips =================
  const rev = (id) => D.review.items[id] || { status: "new", edit: null, notes: [], version: 0 };
  // Mirrors lib/core.mjs: an edit saved but not rendered yet, or a note of Keri's that Claude hasn't answered.
  const editWaiting = (r) => !!r && JSON.stringify(r.edit ?? null) !== JSON.stringify(r.rendered?.edit ?? null);
  const REEL_KEYS = ["pieces", "look", "title", "subtitle", "endcard", "transition", "music"];
  const reelWaiting = (reel) => !!reel && JSON.stringify(Object.fromEntries(REEL_KEYS.map((k) => [k, reel[k] ?? null])))
    !== JSON.stringify(reel.rendered?.plan ? Object.fromEntries(REEL_KEYS.map((k) => [k, reel.rendered.plan[k] ?? null])) : null);
  function noteWaiting(r) {
    const last = (by) => (r?.notes || []).filter((n) => n.by === by).reduce((a, n) => (n.at > a ? n.at : a), "");
    const keri = last("Keri");
    return !!keri && keri > last("Claude");
  }
  // What the pill says: queued work wins over the review status.
  function shown(r, waiting) {
    if (waiting) return { cls: "waiting", text: "⏳ Edit queued" };
    if (noteWaiting(r) && r.status !== "approved") return { cls: "note", text: "💬 Note for Claude" };
    return { cls: r.status, text: STATUS[r.status] };
  }
  const pill = (r, waiting) => { const x = shown(r, waiting); return `<span class="pill ${x.cls}">${x.text}</span>`; };
  const item = (id) => D.items.find((i) => i.id === id);
  // the untouched preview when there is one (tools/studio.py keeps <id>.orig.* once an item has been edited),
  // so the look shown in the studio is applied to the true original, not on top of an earlier edit
  const thumbOf = (i) => (i.type === "video" ? i.origPoster || i.poster : i.origPreview || i.preview) || "";
  const blankEdit = (i) => ({ look: { preset: "original", brightness: 0, contrast: 0, saturation: 0, warmth: 0, fade: 0 }, ...(i.type === "video" ? { speed: 1, trim: null } : {}) });
  const editOf = (id) => {
    const blank = blankEdit(item(id)), e = clone(rev(id).edit);
    return e ? { ...blank, ...e, look: { ...blank.look, ...(e.look || {}) } } : blank;
  };

  function renderItems() {
    const items = D.items.filter((i) => !i.upsellOnly);
    const counts = { all: items.length };
    for (const s of Object.keys(STATUS)) counts[s] = items.filter((i) => rev(i.id).status === s).length;
    counts.queued = items.filter((i) => editWaiting(rev(i.id))).length;
    counts.comp = items.filter((i) => rev(i.id).comp).length;
    const order = ["all", "queued", "new", "edits", "revised", "approved", "comp", "remove"];
    const edited = items.filter((i) => rev(i.id).edit || rev(i.id).rendered?.edit).length;
    $("filters").innerHTML = order.filter((k) => k === "all" || counts[k])
      .map((k) => `<button class="st-chip ${filter === k ? "on" : ""}" data-f="${k}" type="button">${k === "all" ? "All" : k === "queued" ? "⏳ Edit queued" : k === "comp" ? "🎁 Complimentary" : STATUS[k]} · ${counts[k]}</button>`).join("")
      + (edited ? `<button class="st-chip st-undo-all" id="undoAll" type="button">↺ Undo all edits (${edited})</button>` : "");
    const list = items.filter((i) => filter === "all" || (filter === "queued" ? editWaiting(rev(i.id)) : filter === "comp" ? rev(i.id).comp : rev(i.id).status === filter));
    // grouped like the client gallery: Videos, then Pictures, each split into sections (sections.js)
    const thumb = (i) => {
      const r = rev(i.id);
      const userNotes = r.notes.filter((n) => n.by === "Keri").length;
      return `<button class="st-thumb ${i.id === curId ? "on" : ""}" data-id="${esc(i.id)}" type="button">
        <img src="${esc(thumbOf(i))}" alt="" loading="lazy" style="filter:${Looks.cssFilter(r.edit?.look)}">
        ${pill(r, editWaiting(r))}
        ${userNotes ? `<span class="notes">💬 ${userNotes}</span>` : ""}
        ${r.comp ? `<span class="gift" title="Complimentary">🎁</span>` : ""}
        <span class="lbl">${esc(i.title)}${i.duration ? ` · ${secs(i.duration)}` : ""}</span></button>`;
    };
    const part = (title, xs) => {
      if (!xs.length) return "";
      const gs = Sections.groups(xs);
      return `<h3 class="st-sec">${title} · ${xs.length}</h3>` + gs.map((g) =>
        `${gs.length > 1 ? `<div class="st-subsec">${g.label} · ${g.items.length}</div>` : ""}${g.items.map(thumb).join("")}`).join("");
    };
    $("grid").innerHTML = part("Videos", list.filter((i) => i.type === "video")) + part("Pictures", list.filter((i) => i.type !== "video"))
      || `<p class="empty">Nothing here.</p>`;
  }
  $("filters").addEventListener("click", async (e) => {
    if (e.target.closest("#undoAll")) return undoAll();
    const b = e.target.closest("[data-f]"); if (b) { filter = b.dataset.f; renderItems(); }
  });
  // every photo and clip back to its original (the reel is separate); approvals and notes stay
  async function undoAll() {
    const ids = D.items.filter((i) => !i.upsellOnly && (rev(i.id).edit || rev(i.id).rendered?.edit)).map((i) => i.id);
    if (!ids.length || !confirm(`Undo the edits on all ${ids.length} edited photos and clips and go back to the originals? Approvals and notes stay as they are.`)) return;
    let ok = 0;
    for (const id of ids) if (await save({ id, edit: null })) ok++;
    if (curId) draft = editOf(curId);
    renderItems(); if (curId) renderEditor();
    toast(`${ok} item${ok === 1 ? "" : "s"} going back to the original. The final files are restored within 15 minutes.`, 5000);
  }
  $("grid").addEventListener("click", (e) => {
    const b = e.target.closest(".st-thumb"); if (!b) return;
    if (curId && curId !== b.dataset.id && !same(draft, editOf(curId)) && !confirm("You have unsaved changes on this item. Leave without saving?")) return;
    openItem(b.dataset.id);
  });

  function openItem(id) {
    curId = id; draft = editOf(id);
    renderItems(); renderEditor();
    if (matchMedia("(max-width: 860px)").matches) $("editor").scrollIntoView({ behavior: "smooth" });
  }
  function neighbor(step) {
    const ids = [...document.querySelectorAll("#grid .st-thumb")].map((b) => b.dataset.id);
    const i = ids.indexOf(curId);
    return ids[(i + step + ids.length) % ids.length];
  }

  function renderEditor() {
    const i = item(curId); if (!i) { $("editor").innerHTML = `<p class="empty">Pick a photo or clip to review it.</p>`; return; }
    const r = rev(i.id), video = i.type === "video";
    const userNote = video ? `<label class="st-small"><input type="checkbox" id="noteAtTime" checked> at <span id="noteTime">0:00</span></label>` : "";
    $("editor").innerHTML = `
      <div class="st-media">
        ${video ? `<video id="edMedia" src="${esc(i.origPreview || i.preview)}" poster="${esc(i.origPoster || i.poster || "")}" autoplay muted loop playsinline controls controlslist="nodownload noplaybackrate" disablepictureinpicture></video>`
                : `<img id="edMedia" src="${esc(i.origPreview || i.preview)}" alt="">`}
        <button class="st-compare" id="compare" type="button">Hold to see original</button>
      </div>
      <div class="st-ed-head">
        <div><b>${esc(i.title)}</b> ${pill(r, editWaiting(r))}${r.version ? ` <span class="st-muted st-small">v${r.version + 1}</span>` : ""}</div>
        <div><button class="btn ghost small" id="prevItem" type="button">‹ Prev</button> <button class="btn ghost small" id="nextItem" type="button">Next ›</button></div>
      </div>
      <div class="st-status-row">
        <button class="btn approve ${r.status === "approved" ? "is-on" : ""}" data-status="approved" type="button">✓ Approve</button>
        <button class="btn edits ${r.status === "edits" ? "is-on" : ""}" data-status="edits" type="button">Needs edits</button>
        <button class="btn remove ${r.status === "remove" ? "is-on" : ""}" data-status="remove" type="button">Remove</button>
        ${i.upsellOnly ? "" : `<button class="btn comp ${r.comp ? "is-on" : ""}" id="compToggle" type="button" title="A free extra for the client: it goes in their basket at no charge and doesn't use one of their included picks">🎁 Complimentary</button>`}
      </div>
      <h3>Look</h3>
      <div class="st-looks" id="looks"></div>
      <details ${Object.values(draft.look).some((v) => typeof v === "number" && v) ? "open" : ""}><summary class="st-small st-muted" style="cursor:pointer;margin-top:6px">Fine-tune</summary>
        <div class="st-sliders" id="sliders"></div></details>
      ${video ? `<h3>Speed</h3><div class="st-chips" id="speeds"></div>
      <h3>Trim <span class="st-muted st-small">play the clip, then set where it should start and end</span></h3><div class="st-trim" id="trim"></div>` : ""}
      <h3>Notes for the editor</h3>
      <div class="st-notes" id="notes"></div>
      <textarea class="field" id="noteText" placeholder="${video ? "e.g. Cut before the car drives in, or hold the last shot longer" : "e.g. Straighten the horizon, or brighten the faces"}"></textarea>
      <div class="st-note-row">${userNote}<button class="btn ghost small" id="addNote" type="button">Add note</button></div>
      <div class="st-save-row"><span class="st-small" id="dirty"></span>
        ${r.edit || r.rendered?.edit ? `<button class="btn ghost small" id="toOriginal" type="button" title="Undo every edit on this item">↺ Back to original</button>` : ""}
        <button class="btn" id="saveEdit" type="button">Save edit request</button></div>`;
    renderLooks(); renderSliders(); renderNotes();
    if (video) { renderSpeeds(); renderTrim(); }
    applyDraft();
    const m = $("edMedia");
    const hold = (on) => (m.style.filter = on ? "none" : Looks.cssFilter(draft.look));
    for (const ev of ["pointerdown"]) $("compare").addEventListener(ev, () => hold(true));
    for (const ev of ["pointerup", "pointerleave", "pointercancel"]) $("compare").addEventListener(ev, () => hold(false));
    $("prevItem").onclick = () => $("grid").querySelector(`[data-id="${neighbor(-1)}"]`)?.click();
    $("nextItem").onclick = () => $("grid").querySelector(`[data-id="${neighbor(1)}"]`)?.click();
    if (video) {
      m.addEventListener("timeupdate", () => {
        const t = draft.trim;
        if (t && (m.currentTime < t[0] - 0.05 || m.currentTime > t[1])) m.currentTime = t[0];
        if ($("noteTime")) $("noteTime").textContent = clock(m.currentTime);
      });
      m.addEventListener("loadedmetadata", () => { m.playbackRate = draft.speed || 1; });
    }
  }
  function applyDraft() {
    const m = $("edMedia"); if (!m) return;
    m.style.filter = Looks.cssFilter(draft.look);
    if (m.tagName === "VIDEO") m.playbackRate = draft.speed || 1;
    const changed = !same(draft, editOf(curId));
    $("dirty").innerHTML = changed ? `<span class="st-dirty">Unsaved changes</span>` : rev(curId).edit ? "Edit request saved" : "";
    $("saveEdit").disabled = !changed;
  }

  function renderLooks() {
    const i = item(curId);
    $("looks").innerHTML = Object.entries(Looks.PRESETS).map(([k, p]) =>
      `<button class="st-look ${draft.look.preset === k ? "on" : ""}" data-look="${k}" type="button">
        <img src="${esc(thumbOf(i))}" alt="" style="filter:${Looks.cssFilter({ preset: k })}"><span>${p.label}</span></button>`).join("");
  }
  function renderSliders() {
    $("sliders").innerHTML = Looks.SLIDERS.map((s) => {
      const v = draft.look[s.key] || 0;
      return `<label for="sl-${s.key}">${s.label}</label>
        <input type="range" id="sl-${s.key}" data-sl="${s.key}" min="-0.5" max="0.5" step="0.01" value="${v}">
        <span class="st-muted">${v > 0 ? "+" : ""}${Math.round(v * 100)}</span>`;
    }).join("");
  }
  function renderSpeeds() {
    $("speeds").innerHTML = SPEEDS.map((s) => `<button class="st-chip ${draft.speed === s ? "on" : ""}" data-speed="${s}" type="button">${s === 1 ? "Normal" : s < 1 ? `${s}× slow-mo` : `${s}× fast`}</button>`).join("");
  }
  function renderTrim() {
    const d = item(curId).duration || 0, t = draft.trim || [0, d];
    $("trim").innerHTML = `
      <span>Start</span><input type="range" data-trim="0" min="0" max="${d}" step="0.05" value="${t[0]}"><span>${secs(t[0])}</span><button class="btn ghost small" data-trimnow="0" type="button">Set to now</button>
      <span>End</span><input type="range" data-trim="1" min="0" max="${d}" step="0.05" value="${t[1]}"><span>${secs(t[1])}</span><button class="btn ghost small" data-trimnow="1" type="button">Set to now</button>
      <span></span><span class="st-muted st-small">New length ${secs((t[1] - t[0]) / (draft.speed || 1))} (was ${secs(d)})</span><span></span>
      ${draft.trim ? `<button class="btn ghost small" data-trimclear="1" type="button">No trim</button>` : "<span></span>"}`;
  }
  function setTrim(which, v) {
    const d = item(curId).duration || 0;
    const t = draft.trim ? [...draft.trim] : [0, d];
    t[which] = Math.round(Math.min(d, Math.max(0, v)) * 100) / 100;
    // keep at least 0.5s: moving one end past the other pushes the other along
    if (t[1] - t[0] < 0.5) {
      if (which === 0) { t[1] = Math.min(d, t[0] + 0.5); t[0] = Math.min(t[0], t[1] - 0.5); }
      else { t[0] = Math.max(0, t[1] - 0.5); t[1] = Math.max(t[1], t[0] + 0.5); }
    }
    draft.trim = t[0] <= 0.02 && t[1] >= d - 0.02 ? null : t;
    renderTrim(); applyDraft();
    const m = $("edMedia"); if (m) m.currentTime = which === 0 ? t[0] : Math.max(t[0], t[1] - 1.5);
  }
  function renderNotes() {
    const r = rev(curId);
    $("notes").innerHTML = r.notes.map((n, k) => `<div class="st-note ${n.by !== "Keri" ? "claude" : ""}">
        <div class="who"><span>${esc(n.by)} · ${new Date(n.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
          ${n.by === "Keri" ? `<button class="del" data-delnote="${k}" type="button">Delete</button>` : ""}</div>
        ${n.t !== null && n.t !== undefined ? `<button class="t" data-seek="${n.t}" type="button">${clock(n.t)}</button>` : ""}${esc(n.text)}</div>`).join("")
      || `<p class="st-muted st-small" style="margin:0">No notes yet.</p>`;
  }

  $("editor").addEventListener("click", async (e) => {
    const t = e.target.closest("button"); if (!t || !curId) return;
    const m = $("edMedia");
    if (t.dataset.status) {
      const body = { id: curId, status: t.dataset.status };
      if (!same(draft, editOf(curId))) body.edit = draft; // keep look/trim changes made before approving
      if (await save(body)) { draft = editOf(curId); renderItems(); renderEditor(); }
    } else if (t.dataset.look) {
      draft.look = { ...draft.look, preset: t.dataset.look };
      renderLooks(); applyDraft();
    } else if (t.dataset.speed) {
      draft.speed = Number(t.dataset.speed); renderSpeeds(); renderTrim(); applyDraft();
    } else if (t.dataset.trimnow) {
      setTrim(Number(t.dataset.trimnow), m.currentTime);
    } else if (t.dataset.trimclear) {
      draft.trim = null; renderTrim(); applyDraft();
    } else if (t.dataset.seek) {
      m.currentTime = Number(t.dataset.seek); m.pause();
    } else if (t.dataset.delnote) {
      if (!confirm("Delete this note?")) return;
      if (await save({ id: curId, deleteNote: Number(t.dataset.delnote) })) { renderNotes(); renderItems(); }
    } else if (t.id === "addNote") {
      const text = $("noteText").value.trim(); if (!text) return $("noteText").focus();
      const at = m?.tagName === "VIDEO" && $("noteAtTime")?.checked ? m.currentTime : null;
      if (await save({ id: curId, note: { text, t: at } }, "Note saved")) { $("noteText").value = ""; renderNotes(); renderItems(); refreshStatusPill(); }
    } else if (t.id === "compToggle") {
      const on = !rev(curId).comp;
      if (await save({ id: curId, comp: on }, on ? "Complimentary: approved, and free in the client's basket" : "No longer complimentary")) {
        renderItems(); renderEditor(); renderPublish();
      }
    } else if (t.id === "toOriginal") {
      if (!confirm("Undo every edit on this item and go back to the original?")) return;
      if (await save({ id: curId, edit: null }, rev(curId).rendered?.edit ? "Going back to the original. The final file is restored within 15 minutes." : "Edit request cleared")) {
        draft = editOf(curId); renderItems(); renderEditor();
      }
    } else if (t.id === "saveEdit") {
      const isBlank = same(draft, blankEdit(item(curId)));
      if (await save({ id: curId, edit: isBlank ? null : draft }, isBlank ? "Edit request cleared" : "Edit request saved. Claude will make the final version.")) {
        draft = editOf(curId); renderItems(); renderEditor();
      }
    }
  });
  function refreshStatusPill() {
    const r = rev(curId), p = $("editor").querySelector(".st-ed-head .pill");
    if (p) { const x = shown(r, editWaiting(r)); p.className = `pill ${x.cls}`; p.textContent = x.text; }
    for (const b of $("editor").querySelectorAll("[data-status]")) b.classList.toggle("is-on", b.dataset.status === r.status);
  }
  $("editor").addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.sl) {
      draft.look = { ...draft.look, [t.dataset.sl]: Number(t.value) };
      t.nextElementSibling.textContent = `${t.value > 0 ? "+" : ""}${Math.round(t.value * 100)}`;
      applyDraft();
    } else if (t.dataset.trim) setTrim(Number(t.dataset.trim), Number(t.value));
  });

  // ================= highlight reel =================
  const clips = () => D.items.filter((i) => i.type === "video" && !i.upsellOnly);
  const clipById = (id) => clips().find((c) => c.id === id);
  const blankReel = () => ({ pieces: [], look: null, title: D.client.eventName, subtitle: D.client.clientName, endcard: "", transition: "fade", music: "" });
  // Several reels: "legacy" = the gallery's own reel (review.reel), or a highlight reel add-on's item id
  // (its plan in review.reels[id]; its status and notes are the item's, like any clip).
  const REEL_ORDER = ["web-30", "web-60", "web-90", "social-7", "social-15", "social-30", "social-60"];
  const addonReels = () => D.items.filter((i) => i.reel).sort((a, b) => REEL_ORDER.indexOf(a.reel) - REEL_ORDER.indexOf(b.reel));
  const reelKeys = () => [...(D.items.some((i) => i.id === "highlight-reel") ? ["legacy"] : []), ...addonReels().map((i) => i.id)];
  const planOf = (k) => (k === "legacy" ? D.review.reel : D.review.reels?.[k]);
  const reelRev = (k) => (k === "legacy" ? D.review.reel || { status: "new", notes: [] } : rev(k));
  const reelWait = (k) => reelWaiting(planOf(k)) || (k !== "legacy" && editWaiting(D.review.items[k]));
  const reelName = (k) => (k === "legacy" ? "Your reel" : item(k).title.replace(/^.* reel · /, ""));
  const reelTarget = (k) => (k === "legacy" ? null : item(k).duration && REEL_SECONDS[item(k).reel]);
  const REEL_SECONDS = { "web-30": 30, "web-60": 60, "web-90": 90, "social-7": 7, "social-15": 15, "social-30": 30, "social-60": 60 };
  let reelKey = "legacy";
  function reelFromReview() {
    const r = planOf(reelKey);
    if (!r) return blankReel();
    const { pieces, look, title, subtitle, endcard, transition, music } = r;
    return clone({ pieces, look, title, subtitle, endcard, transition, music });
  }
  const pieceLen = (p) => (p.out - p.in) / (p.speed || 1);
  function reelLength() {
    const n = rdraft.pieces.length;
    return rdraft.pieces.reduce((a, p) => a + pieceLen(p), 0) - (rdraft.transition === "fade" ? Math.max(0, n - 1) * XF : 0);
  }

  function renderReelPick() {
    const chip = (k) => { const r = reelRev(k);
      return `<button class="st-chip ${k === reelKey ? "on" : ""}" data-reelkey="${esc(k)}" type="button">${esc(reelName(k))}${r.status === "approved" ? " ✓" : reelWait(k) ? " ⏳" : ""}</button>`; };
    const group = (label, ks) => (ks.length ? `<div class="st-reel-grp"><span>${label}</span>${ks.map(chip).join("")}</div>` : "");
    const ks = reelKeys(), adds = addonReels();
    $("reelPick").innerHTML = group("", ks.filter((k) => k === "legacy"))
      + group("Website &amp; YouTube", adds.filter((i) => i.orientation === "landscape").map((i) => i.id))
      + group("Social media", adds.filter((i) => i.orientation !== "landscape").map((i) => i.id));
  }
  function renderReel() {
    if (!D) return;
    if (!rdraft) rdraft = reelFromReview();
    renderReelPick();
    const r = reelRev(reelKey), it = reelKey === "legacy" ? null : item(reelKey);
    $("reelFrame").classList.toggle("wide", it?.orientation === "landscape");
    const watch = it ? it.preview : `/media/${encodeURIComponent(slug)}/reel-sample.mp4`;
    $("reelInfo").innerHTML = it
      ? `<b>${esc(it.title)}</b> · ${it.orientation === "landscape" ? "horizontal" : "vertical"} · aim for ${clock(reelTarget(reelKey))}.
         Approve it and give it a price on the project page to offer it to the client. <a href="${esc(watch)}" target="_blank">▶ Watch the finished version</a>`
      : `<b>Your reel</b> · vertical. <a href="${esc(watch)}" target="_blank">▶ Watch the finished version</a>`;
    $("reelStatus").innerHTML = `${pill(r, reelWait(reelKey))}
      <button class="btn approve small ${r.status === "approved" ? "is-on" : ""}" data-rstatus="approved" type="button">✓ Approve reel</button>
      <button class="btn edits small ${r.status === "edits" ? "is-on" : ""}" data-rstatus="edits" type="button">Needs edits</button>
      ${it ? `<button class="btn remove small ${r.status === "remove" ? "is-on" : ""}" data-rstatus="remove" type="button">Don't offer</button>` : ""}`;
    renderTimeline(); renderPiece(); renderReelForm(); renderReelNotes(); markReelDirty();
    $("clipPick").innerHTML = clips().map((c) => `<button data-addclip="${esc(c.id)}" type="button"><img src="${esc(c.poster)}" alt="">${esc(c.title)} · ${secs(c.duration)}</button>`).join("");
    showReelFrame(0);
  }
  function renderTimeline() {
    $("timeline").innerHTML = rdraft.pieces.map((p, k) => {
      const c = clipById(p.clip);
      return `<button class="st-pc ${k === pieceIdx ? "on" : ""}" draggable="true" data-pc="${k}" type="button">
        <span class="n">${k + 1}</span><img src="${esc(c?.poster || "")}" alt="" style="filter:${Looks.cssFilter(p.look || rdraft.look)}">
        <span>${esc(c?.title.replace("Clip ", "Clip ") || p.clip)}<br>${secs(pieceLen(p))}${p.speed !== 1 ? ` · ${p.speed}×` : ""}</span></button>`;
    }).join("") || `<p class="st-muted st-small">No pieces yet. Add one from a clip below.</p>`;
    $("reelClock").textContent = `0:00 / ${clock(reelLength())}`;
  }
  function renderPiece() {
    const p = rdraft.pieces[pieceIdx];
    if (!p) { $("pieceEditor").innerHTML = ""; return; }
    const c = clipById(p.clip), d = c.duration;
    const lookOpts = [["", "Same as reel"], ...Object.entries(Looks.PRESETS).map(([k, v]) => [k, v.label])];
    $("pieceEditor").innerHTML = `
      <div class="st-piece-head"><b>Piece ${pieceIdx + 1}</b>
        <span><button class="btn ghost small" data-move="-1" type="button">◀ Move</button> <button class="btn ghost small" data-move="1" type="button">Move ▶</button>
        <button class="btn ghost small" data-playpiece="1" type="button">▶ Preview</button> <button class="btn remove small" data-delpiece="1" type="button">Remove</button></span></div>
      <div class="st-form">
        <span>From clip</span><select class="field" data-pf="clip">${clips().map((x) => `<option value="${esc(x.id)}" ${x.id === p.clip ? "selected" : ""}>${esc(x.title)} (${secs(x.duration)})</option>`).join("")}</select>
      </div>
      <div class="st-trim" style="margin-top:8px">
        <span>Start</span><input type="range" data-pt="in" min="0" max="${d}" step="0.05" value="${p.in}"><span>${secs(p.in)}</span><button class="btn ghost small" data-ptnow="in" type="button">Set to now</button>
        <span>End</span><input type="range" data-pt="out" min="0" max="${d}" step="0.05" value="${p.out}"><span>${secs(p.out)}</span><button class="btn ghost small" data-ptnow="out" type="button">Set to now</button>
      </div>
      <h3>Speed</h3><div class="st-chips">${SPEEDS.map((s) => `<button class="st-chip ${p.speed === s ? "on" : ""}" data-pspeed="${s}" type="button">${s === 1 ? "Normal" : `${s}×`}</button>`).join("")}</div>
      <h3>Look for this piece</h3><div class="st-chips">${lookOpts.map(([k, l]) => `<button class="st-chip ${(p.look?.preset || "") === k ? "on" : ""}" data-plook="${k}" type="button">${l}</button>`).join("")}</div>`;
  }
  function renderReelForm() {
    const lookOpts = Object.entries(Looks.PRESETS).map(([k, v]) => `<option value="${k}" ${(rdraft.look?.preset || "original") === k ? "selected" : ""}>${v.label}</option>`).join("");
    $("reelForm").innerHTML = `
      <span>Title</span><input class="field" data-rf="title" value="${esc(rdraft.title)}">
      <span>Subtitle</span><input class="field" data-rf="subtitle" value="${esc(rdraft.subtitle)}">
      <span>Closing text</span><input class="field" data-rf="endcard" value="${esc(rdraft.endcard)}" placeholder="e.g. October 31, 2026">
      <span>Transitions</span><select class="field" data-rf="transition"><option value="fade" ${rdraft.transition === "fade" ? "selected" : ""}>Soft crossfade</option><option value="cut" ${rdraft.transition === "cut" ? "selected" : ""}>Hard cut</option></select>
      <span>Overall look</span><select class="field" data-rf="look">${lookOpts}</select>
      <span>Music</span><input class="field" data-rf="music" value="${esc(rdraft.music)}" placeholder="Song you have a license for, or the mood you want">`;
  }
  function renderReelNotes() {
    const notes = reelRev(reelKey).notes || [];
    $("reelNotes").innerHTML = `<div class="st-notes">${notes.map((n, k) => `<div class="st-note ${n.by !== "Keri" ? "claude" : ""}">
        <div class="who"><span>${esc(n.by)} · ${new Date(n.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
        ${n.by === "Keri" ? `<button class="del" data-rdelnote="${k}" type="button">Delete</button>` : ""}</div>
        ${n.t !== null && n.t !== undefined ? `<span class="t">${clock(n.t)}</span>` : ""}${esc(n.text)}</div>`).join("") || `<p class="st-muted st-small" style="margin:0">No notes yet.</p>`}</div>
      <textarea class="field" id="reelNoteText" placeholder="e.g. Open on the drone shot of the bounce houses, and end on the crowd"></textarea>
      <div class="st-note-row"><label class="st-small"><input type="checkbox" id="reelNoteAt"> at reel time <span id="reelNoteTime">0:00</span></label>
        <button class="btn ghost small" id="reelAddNote" type="button">Add note</button></div>`;
  }
  function markReelDirty() {
    const changed = !same(rdraft, reelFromReview());
    const target = reelTarget(reelKey), len = clock(reelLength()) + " long" + (target && Math.abs(reelLength() - target) > 0.5 ? ` (aim for ${clock(target)})` : "");
    $("reelDirty").innerHTML = changed ? `<span class="st-dirty">Unsaved changes</span> · ${len}` : len;
    $("reelSave").disabled = !changed;
  }
  function reelChanged() { renderTimeline(); markReelDirty(); }

  $("tab-reel").addEventListener("click", async (e) => {
    const t = e.target.closest("button"); if (!t) return;
    const p = rdraft.pieces[pieceIdx];
    if (t.dataset.pc !== undefined) { pieceIdx = Number(t.dataset.pc); renderTimeline(); renderPiece(); showReelFrame(pieceIdx); }
    else if (t.dataset.addclip) {
      const c = clipById(t.dataset.addclip);
      rdraft.pieces.push({ clip: c.id, in: 0, out: Math.round(Math.min(c.duration, 3.5) * 100) / 100, speed: 1, look: null });
      pieceIdx = rdraft.pieces.length - 1; reelChanged(); renderPiece(); showReelFrame(pieceIdx);
      t.closest("details").open = false;
    }
    else if (t.dataset.move && p) {
      const to = pieceIdx + Number(t.dataset.move); if (to < 0 || to >= rdraft.pieces.length) return;
      rdraft.pieces.splice(to, 0, rdraft.pieces.splice(pieceIdx, 1)[0]); pieceIdx = to; reelChanged(); renderPiece();
    }
    else if (t.dataset.delpiece && p) { rdraft.pieces.splice(pieceIdx, 1); pieceIdx = Math.min(pieceIdx, rdraft.pieces.length - 1); reelChanged(); renderPiece(); }
    else if (t.dataset.playpiece && p) playReel(pieceIdx, true);
    else if (t.dataset.ptnow && p) setPieceTime(t.dataset.ptnow, curV().currentTime);
    else if (t.dataset.pspeed && p) { p.speed = Number(t.dataset.pspeed); reelChanged(); renderPiece(); }
    else if (t.dataset.plook !== undefined && p) { p.look = t.dataset.plook ? { preset: t.dataset.plook } : null; reelChanged(); renderPiece(); showReelFrame(pieceIdx); }
    else if (t.dataset.reelkey) {
      if (t.dataset.reelkey === reelKey) return;
      if (!same(rdraft, reelFromReview()) && !confirm("This reel has unsaved changes. Switch reels anyway?")) return;
      stopReel(); reelKey = t.dataset.reelkey; rdraft = reelFromReview(); pieceIdx = rdraft.pieces.length ? 0 : -1; renderReel();
    }
    else if (t.dataset.rstatus) {
      const body = reelKey === "legacy" ? { reelStatus: t.dataset.rstatus } : { id: reelKey, status: t.dataset.rstatus };
      if (await save(body, "Reel status saved")) renderReel();
    }
    else if (t.dataset.rdelnote) {
      const body = reelKey === "legacy" ? { reelDeleteNote: Number(t.dataset.rdelnote) } : { id: reelKey, deleteNote: Number(t.dataset.rdelnote) };
      if (confirm("Delete this note?") && (await save(body))) renderReelNotes();
    }
    else if (t.id === "reelAddNote") {
      const text = $("reelNoteText").value.trim(); if (!text) return $("reelNoteText").focus();
      const n = { text, t: $("reelNoteAt").checked ? seq.reelTime : null };
      if (await save(reelKey === "legacy" ? { reelNote: n } : { id: reelKey, note: n }, "Note saved")) renderReel();
    }
    else if (t.id === "reelSave") {
      const body = reelKey === "legacy" ? { reel: rdraft } : { reelId: reelKey, reel: rdraft };
      if (await save(body, "Reel saved. The new version is made within 15 minutes.")) { rdraft = reelFromReview(); renderReel(); }
    }
    else if (t.id === "reelPlay") seq.playing ? stopReel() : playReel(0, false);
  });
  $("tab-reel").addEventListener("input", (e) => {
    const t = e.target, p = rdraft.pieces[pieceIdx];
    if (t.dataset.pt && p) setPieceTime(t.dataset.pt, Number(t.value));
    else if (t.dataset.rf) {
      const k = t.dataset.rf;
      if (k === "look") rdraft.look = t.value === "original" ? null : { preset: t.value };
      else rdraft[k] = t.value;
      if (k === "look") renderTimeline();
      markReelDirty(); if (k === "transition") renderTimeline();
    }
  });
  $("tab-reel").addEventListener("change", (e) => {
    const t = e.target, p = rdraft.pieces[pieceIdx];
    if (t.dataset.pf === "clip" && p) {
      const c = clipById(t.value);
      p.clip = c.id; p.in = 0; p.out = Math.round(Math.min(c.duration, Math.max(1, p.out - p.in)) * 100) / 100;
      reelChanged(); renderPiece(); showReelFrame(pieceIdx);
    }
  });
  function setPieceTime(which, v) {
    const p = rdraft.pieces[pieceIdx], d = clipById(p.clip).duration;
    p[which] = Math.round(Math.min(d, Math.max(0, v)) * 100) / 100;
    if (p.out - p.in < 0.5) {
      if (which === "in") { p.out = Math.min(d, p.in + 0.5); p.in = Math.min(p.in, p.out - 0.5); }
      else { p.in = Math.max(0, p.out - 0.5); p.out = Math.max(p.out, p.in + 0.5); }
    }
    reelChanged(); renderPiece();
    const vEl = curV(); stopReel(); vEl.currentTime = which === "in" ? p.in : Math.max(p.in, p.out - 0.05);
  }

  // drag to reorder pieces
  let dragFrom = null;
  $("timeline").addEventListener("dragstart", (e) => { const b = e.target.closest(".st-pc"); if (!b) return; dragFrom = Number(b.dataset.pc); b.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; });
  $("timeline").addEventListener("dragover", (e) => { const b = e.target.closest(".st-pc"); if (!b || dragFrom === null) return; e.preventDefault(); for (const x of $("timeline").children) x.classList.toggle("drag-over", x === b); });
  $("timeline").addEventListener("dragend", () => { dragFrom = null; for (const x of $("timeline").children) x.classList.remove("drag-over", "dragging"); });
  $("timeline").addEventListener("drop", (e) => {
    e.preventDefault();
    const b = e.target.closest(".st-pc"); if (!b || dragFrom === null) return;
    const to = Number(b.dataset.pc);
    if (to !== dragFrom) { const [m] = rdraft.pieces.splice(dragFrom, 1); rdraft.pieces.splice(to, 0, m); pieceIdx = to; reelChanged(); renderPiece(); }
    dragFrom = null;
  });

  // Reel preview: plays each piece's clip preview from its start to its end, at its speed and look.
  const seq = { playing: false, i: 0, single: false, reelTime: 0, raf: 0 };
  const startOf = (k) => rdraft.pieces.slice(0, k).reduce((a, p) => a + pieceLen(p) - (rdraft.transition === "fade" ? XF : 0), 0);
  // Two stacked players: the next piece loads and seeks in the hidden one, then they swap, so the preview never
  // shows a black gap while a clip loads (Keri, Nov 2, 2026: "remove the black spaces between each clip").
  const R = {};
  function vids() {
    if (!R.a || !R.a.isConnected) {
      R.a = $("reelVideo"); R.a.style.opacity = "1";
      R.b = R.a.cloneNode(); R.b.id = "reelVideoB"; R.b.classList.add("st-reel-buf"); R.b.style.opacity = "0";
      R.a.after(R.b);
    }
    return R;
  }
  const curV = () => { const { a, b } = vids(); return b.style.opacity === "1" ? b : a; };
  function prepare(k) {
    if (seq.prep?.k === k) return seq.prep.done;
    const p = rdraft.pieces[k], c = clipById(p.clip), cur = curV(), nxt = cur === R.a ? R.b : R.a;
    const done = new Promise((res) => {
      const ready = () => res(nxt);
      const seek = () => { nxt.addEventListener("seeked", ready, { once: true }); setTimeout(ready, 1500); nxt.currentTime = p.in; };
      if (!nxt.src.endsWith(c.preview)) { nxt.src = c.preview; nxt.addEventListener("loadedmetadata", seek, { once: true }); } else seek();
    });
    seq.prep = { k, done };
    return done;
  }
  async function loadPiece(k, then) {
    const p = rdraft.pieces[k]; if (!p) return;
    for (const b of $("timeline").children) b.classList.toggle("playing", Number(b.dataset.pc) === k && seq.playing);
    seq.switching = true;
    const nxt = await prepare(k), cur = curV();
    seq.prep = null;
    nxt.playbackRate = p.speed || 1; nxt.style.filter = Looks.cssFilter(p.look || rdraft.look);
    if (then) await then(nxt);
    nxt.style.opacity = "1";
    if (cur !== nxt) { cur.style.opacity = "0"; cur.pause(); }
    seq.switching = false;
  }
  function showReelFrame(k) { if (!seq.playing && rdraft.pieces[Math.max(0, k)]) loadPiece(Math.max(0, k)); updateTitle(k > 0 ? 99 : 0); }
  function updateTitle(t) {
    const o = $("reelTitle");
    o.innerHTML = rdraft.title ? `<div class="t1">${esc(rdraft.title)}</div>${rdraft.subtitle ? `<div class="t2">${esc(rdraft.subtitle)}</div>` : ""}` : "";
    o.style.opacity = t < 4.2 && rdraft.title ? "1" : "0";
  }
  function playReel(k, single) {
    if (!rdraft.pieces.length) return;
    seq.playing = true; seq.i = k; seq.single = single;
    $("reelPlay").textContent = "■ Stop";
    loadPiece(k, (v) => v.play().catch(() => {}));
    cancelAnimationFrame(seq.raf); seq.raf = requestAnimationFrame(tick);
  }
  function stopReel() {
    seq.playing = false; cancelAnimationFrame(seq.raf);
    for (const v of [R.a, R.b]) if (v) v.pause();
    if ($("reelPlay")) $("reelPlay").textContent = "▶ Play reel";
    for (const b of $("timeline")?.children || []) b.classList.remove("playing");
  }
  function tick() {
    if (!seq.playing) return;
    const v = curV(), p = rdraft.pieces[seq.i];
    if (p && !seq.switching && !v.seeking && v.readyState >= 2) {
      seq.reelTime = startOf(seq.i) + Math.max(0, v.currentTime - p.in) / (p.speed || 1);
      $("reelClock").textContent = `${clock(seq.reelTime)} / ${clock(reelLength())}`;
      if ($("reelNoteTime")) $("reelNoteTime").textContent = clock(seq.reelTime);
      updateTitle(seq.single ? 99 : seq.reelTime);
      // get the next piece ready in the hidden player a little before this one ends
      if (!seq.single && seq.i + 1 < rdraft.pieces.length && v.currentTime >= p.out - 0.8) prepare(seq.i + 1);
      if (v.currentTime >= p.out - 0.03 || v.ended) {
        if (seq.single) loadPiece(seq.i, (n) => n.play().catch(() => {}));
        else if (seq.i + 1 < rdraft.pieces.length) { seq.i++; loadPiece(seq.i, (n) => n.play().catch(() => {})); }
        else { stopReel(); return; }
      }
    }
    seq.raf = requestAnimationFrame(tick);
  }

  boot();
})();
