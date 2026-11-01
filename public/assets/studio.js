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
    renderPublish();
    renderItems();
    if (!rdraft) rdraft = reelFromReview();
    renderReel();
    if (tab === "upload") loadUploads();
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
  window.addEventListener("beforeunload", (e) => { if (unsaved() || uploading) { e.preventDefault(); e.returnValue = ""; } });

  // ---------- tabs ----------
  function setTab(t) {
    tab = ["items", "reel", "upload"].includes(t) ? t : "items";
    for (const b of document.querySelectorAll("#stTabs .tab")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
    for (const k of ["items", "reel", "upload"]) $(`tab-${k}`).classList.toggle("hidden", k !== tab);
    if (tab !== "reel") stopReel();
    if (tab === "upload" && D) loadUploads();
  }
  $("stTabs").addEventListener("click", (e) => { const b = e.target.closest(".tab"); if (b) setTab(b.dataset.tab); });

  // ---------- publish ----------
  function renderPublish() {
    const items = D.items.filter((i) => !i.upsellOnly);
    const approved = items.filter((i) => rev(i.id).status === "approved").length;
    const pub = D.review.published;
    $("pubText").innerHTML = pub
      ? `<span class="live">● Published</span> · client sees ${approved} approved item${approved === 1 ? "" : "s"}`
      : `Not published · ${approved} of ${items.length} approved`;
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
  const item = (id) => D.items.find((i) => i.id === id);
  const thumbOf = (i) => (i.type === "video" ? i.poster : i.preview) || "";
  const blankEdit = (i) => ({ look: { preset: "original", brightness: 0, contrast: 0, saturation: 0, warmth: 0, fade: 0 }, ...(i.type === "video" ? { speed: 1, trim: null } : {}) });
  const editOf = (id) => {
    const blank = blankEdit(item(id)), e = clone(rev(id).edit);
    return e ? { ...blank, ...e, look: { ...blank.look, ...(e.look || {}) } } : blank;
  };

  function renderItems() {
    const items = D.items.filter((i) => !i.upsellOnly);
    const counts = { all: items.length };
    for (const s of Object.keys(STATUS)) counts[s] = items.filter((i) => rev(i.id).status === s).length;
    const order = ["all", "new", "edits", "revised", "approved", "remove"];
    $("filters").innerHTML = order.filter((k) => k === "all" || counts[k])
      .map((k) => `<button class="st-chip ${filter === k ? "on" : ""}" data-f="${k}" type="button">${k === "all" ? "All" : STATUS[k]} · ${counts[k]}</button>`).join("");
    const shown = items.filter((i) => filter === "all" || rev(i.id).status === filter);
    $("grid").innerHTML = shown.map((i) => {
      const r = rev(i.id);
      const userNotes = r.notes.filter((n) => n.by !== "Claude").length;
      return `<button class="st-thumb ${i.id === curId ? "on" : ""}" data-id="${esc(i.id)}" type="button">
        <img src="${esc(thumbOf(i))}" alt="" loading="lazy" style="filter:${Looks.cssFilter(r.edit?.look)}">
        <span class="pill ${r.status}">${STATUS[r.status]}</span>
        ${userNotes ? `<span class="notes">💬 ${userNotes}</span>` : ""}
        <span class="lbl">${esc(i.title)}${i.duration ? ` · ${secs(i.duration)}` : ""}</span></button>`;
    }).join("") || `<p class="empty">Nothing here.</p>`;
  }
  $("filters").addEventListener("click", (e) => { const b = e.target.closest("[data-f]"); if (b) { filter = b.dataset.f; renderItems(); } });
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
        ${video ? `<video id="edMedia" src="${esc(i.preview)}" poster="${esc(i.poster || "")}" autoplay muted loop playsinline controls controlslist="nodownload noplaybackrate" disablepictureinpicture></video>`
                : `<img id="edMedia" src="${esc(i.preview)}" alt="">`}
        <button class="st-compare" id="compare" type="button">Hold to see original</button>
      </div>
      <div class="st-ed-head">
        <div><b>${esc(i.title)}</b> <span class="pill ${r.status}">${STATUS[r.status]}</span>${r.version ? ` <span class="st-muted st-small">v${r.version + 1}</span>` : ""}</div>
        <div><button class="btn ghost small" id="prevItem" type="button">‹ Prev</button> <button class="btn ghost small" id="nextItem" type="button">Next ›</button></div>
      </div>
      <div class="st-status-row">
        <button class="btn approve ${r.status === "approved" ? "is-on" : ""}" data-status="approved" type="button">✓ Approve</button>
        <button class="btn edits ${r.status === "edits" ? "is-on" : ""}" data-status="edits" type="button">Needs edits</button>
        <button class="btn remove ${r.status === "remove" ? "is-on" : ""}" data-status="remove" type="button">Remove</button>
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
        <button class="btn ghost small" id="resetEdit" type="button">Reset</button>
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
    $("notes").innerHTML = r.notes.map((n, k) => `<div class="st-note ${n.by === "Claude" ? "claude" : ""}">
        <div class="who"><span>${esc(n.by)} · ${new Date(n.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
          ${n.by !== "Claude" ? `<button class="del" data-delnote="${k}" type="button">Delete</button>` : ""}</div>
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
    } else if (t.id === "resetEdit") {
      draft = blankEdit(item(curId)); renderEditor();
    } else if (t.id === "saveEdit") {
      const isBlank = same(draft, blankEdit(item(curId)));
      if (await save({ id: curId, edit: isBlank ? null : draft }, isBlank ? "Edit request cleared" : "Edit request saved. Claude will make the final version.")) {
        draft = editOf(curId); renderItems(); renderEditor();
      }
    }
  });
  function refreshStatusPill() {
    const r = rev(curId), p = $("editor").querySelector(".st-ed-head .pill");
    if (p) { p.className = `pill ${r.status}`; p.textContent = STATUS[r.status]; }
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
  function reelFromReview() {
    const r = D.review.reel;
    if (!r) return blankReel();
    const { pieces, look, title, subtitle, endcard, transition, music } = r;
    return clone({ pieces, look, title, subtitle, endcard, transition, music });
  }
  const pieceLen = (p) => (p.out - p.in) / (p.speed || 1);
  function reelLength() {
    const n = rdraft.pieces.length;
    return rdraft.pieces.reduce((a, p) => a + pieceLen(p), 0) - (rdraft.transition === "fade" ? Math.max(0, n - 1) * XF : 0);
  }

  function renderReel() {
    if (!D) return;
    const r = D.review.reel || { status: "new", notes: [] };
    $("reelStatus").innerHTML = `<span class="pill ${r.status}">${STATUS[r.status]}</span>
      <button class="btn approve small ${r.status === "approved" ? "is-on" : ""}" data-rstatus="approved" type="button">✓ Approve reel</button>
      <button class="btn edits small ${r.status === "edits" ? "is-on" : ""}" data-rstatus="edits" type="button">Needs edits</button>`;
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
    const notes = D.review.reel?.notes || [];
    $("reelNotes").innerHTML = `<div class="st-notes">${notes.map((n, k) => `<div class="st-note ${n.by === "Claude" ? "claude" : ""}">
        <div class="who"><span>${esc(n.by)} · ${new Date(n.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
        ${n.by !== "Claude" ? `<button class="del" data-rdelnote="${k}" type="button">Delete</button>` : ""}</div>
        ${n.t !== null && n.t !== undefined ? `<span class="t">${clock(n.t)}</span>` : ""}${esc(n.text)}</div>`).join("") || `<p class="st-muted st-small" style="margin:0">No notes yet.</p>`}</div>
      <textarea class="field" id="reelNoteText" placeholder="e.g. Open on the drone shot of the bounce houses, and end on the crowd"></textarea>
      <div class="st-note-row"><label class="st-small"><input type="checkbox" id="reelNoteAt"> at reel time <span id="reelNoteTime">0:00</span></label>
        <button class="btn ghost small" id="reelAddNote" type="button">Add note</button></div>`;
  }
  function markReelDirty() {
    const changed = !same(rdraft, reelFromReview());
    $("reelDirty").innerHTML = changed ? `<span class="st-dirty">Unsaved changes</span> · ${clock(reelLength())} long` : `${clock(reelLength())} long`;
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
    else if (t.dataset.ptnow && p) setPieceTime(t.dataset.ptnow, $("reelVideo").currentTime);
    else if (t.dataset.pspeed && p) { p.speed = Number(t.dataset.pspeed); reelChanged(); renderPiece(); }
    else if (t.dataset.plook !== undefined && p) { p.look = t.dataset.plook ? { preset: t.dataset.plook } : null; reelChanged(); renderPiece(); showReelFrame(pieceIdx); }
    else if (t.dataset.rstatus) { if (await save({ reelStatus: t.dataset.rstatus }, "Reel status saved")) renderReel(); }
    else if (t.dataset.rdelnote) { if (confirm("Delete this note?") && (await save({ reelDeleteNote: Number(t.dataset.rdelnote) }))) renderReelNotes(); }
    else if (t.id === "reelAddNote") {
      const text = $("reelNoteText").value.trim(); if (!text) return $("reelNoteText").focus();
      if (await save({ reelNote: { text, t: $("reelNoteAt").checked ? seq.reelTime : null } }, "Note saved")) renderReel();
    }
    else if (t.id === "reelSave") {
      if (await save({ reel: rdraft }, "Reel saved. Claude will render the new version.")) { rdraft = reelFromReview(); renderReel(); }
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
    const vEl = $("reelVideo"); stopReel(); vEl.currentTime = which === "in" ? p.in : Math.max(p.in, p.out - 0.05);
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
  function loadPiece(k, then) {
    const p = rdraft.pieces[k], v = $("reelVideo"); if (!p) return;
    const c = clipById(p.clip);
    const go = () => { v.currentTime = p.in; v.playbackRate = p.speed || 1; v.style.filter = Looks.cssFilter(p.look || rdraft.look); then && then(); };
    for (const b of $("timeline").children) b.classList.toggle("playing", Number(b.dataset.pc) === k && seq.playing);
    if (!v.src.endsWith(c.preview)) { v.src = c.preview; v.addEventListener("loadedmetadata", go, { once: true }); } else go();
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
    loadPiece(k, () => $("reelVideo").play());
    cancelAnimationFrame(seq.raf); seq.raf = requestAnimationFrame(tick);
  }
  function stopReel() {
    seq.playing = false; cancelAnimationFrame(seq.raf);
    const v = $("reelVideo"); if (v) v.pause();
    if ($("reelPlay")) $("reelPlay").textContent = "▶ Play reel";
    for (const b of $("timeline")?.children || []) b.classList.remove("playing");
  }
  function tick() {
    if (!seq.playing) return;
    const v = $("reelVideo"), p = rdraft.pieces[seq.i];
    if (p && !v.seeking && v.readyState >= 2) {
      seq.reelTime = startOf(seq.i) + Math.max(0, v.currentTime - p.in) / (p.speed || 1);
      $("reelClock").textContent = `${clock(seq.reelTime)} / ${clock(reelLength())}`;
      if ($("reelNoteTime")) $("reelNoteTime").textContent = clock(seq.reelTime);
      updateTitle(seq.single ? 99 : seq.reelTime);
      if (v.currentTime >= p.out - 0.03 || v.ended) {
        if (seq.single) loadPiece(seq.i, () => v.play());
        else if (seq.i + 1 < rdraft.pieces.length) { seq.i++; loadPiece(seq.i, () => v.play()); }
        else { stopReel(); return; }
      }
    }
    seq.raf = requestAnimationFrame(tick);
  }

  // ================= uploads (raw files to R2) =================
  let uploading = 0, project = null, queue = [], wakeLock = null;
  const PART = 16 * 1024 * 1024;
  const mb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);

  async function loadUploads() {
    const r = await api("/api/admin/raw/projects");
    if (!r.ok) { $("upList").innerHTML = `<p class="err">${esc(r.body.error)}</p>`; return; }
    if (!project) project = slug;
    const names = [...new Set([...r.body.projects, project])].sort();
    $("proj").innerHTML = names.map((n) => `<option value="${esc(n)}" ${n === project ? "selected" : ""}>${esc(n)}</option>`).join("");
    listCloud();
  }
  $("proj").addEventListener("change", () => { project = $("proj").value; listCloud(); });
  $("newProj").addEventListener("click", () => {
    const n = (prompt("Name for the new project (for example: smith-wedding-2026):") || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!n) return;
    project = n; $("proj").insertAdjacentHTML("beforeend", `<option value="${esc(n)}">${esc(n)}</option>`); $("proj").value = n; listCloud();
  });
  async function listCloud() {
    const r = await api(`/api/admin/raw/list?project=${encodeURIComponent(project)}`);
    if (!r.ok) { $("cloudFiles").innerHTML = ""; return; }
    const files = r.body.files.sort((a, b) => a.path.localeCompare(b.path));
    $("cloudSum").textContent = files.length ? `${files.length} file${files.length === 1 ? "" : "s"} · ${mb(files.reduce((a, f) => a + f.size, 0))}` : "";
    $("cloudFiles").innerHTML = `<tr><th>File</th><th>Size</th><th>Added</th><th></th></tr>` + (files.map((f) =>
      `<tr><td>${esc(f.path)}</td><td>${mb(f.size)}</td><td>${new Date(f.modified).toLocaleDateString()}</td>
        <td><button class="btn ghost small" data-dl="${esc(f.path)}" type="button">Download</button></td></tr>`).join("")
      || `<tr><td colspan="4" class="st-muted">Nothing uploaded to “${esc(project)}” yet.</td></tr>`);
  }
  $("cloudFiles").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-dl]"); if (!b) return;
    const r = await api(`/api/admin/raw/url?project=${encodeURIComponent(project)}&path=${encodeURIComponent(b.dataset.dl)}`);
    if (r.ok) location.href = r.body.url; else toast(r.body.error);
  });

  // Collect files from a drop, keeping folder structure (folder/sub/file.jpg).
  async function entriesFromDrop(dt) {
    const out = [];
    const walk = (entry, path) => new Promise((resolve) => {
      if (entry.isFile) entry.file((f) => { out.push({ file: f, path: path + f.name }); resolve(); }, () => resolve());
      else if (entry.isDirectory) {
        const reader = entry.createReader(), all = [];
        const read = () => reader.readEntries(async (batch) => {
          if (!batch.length) { for (const en of all) await walk(en, `${path}${entry.name}/`); resolve(); }
          else { all.push(...batch); read(); }
        }, () => resolve());
        read();
      } else resolve();
    });
    const roots = [...dt.items].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    if (!roots.length) return [...dt.files].map((f) => ({ file: f, path: f.name }));
    for (const r of roots) await walk(r, "");
    return out;
  }
  const keep = (x) => !x.path.split("/").some((s) => s.startsWith(".")) && x.file.size > 0;
  function enqueue(list) {
    if (!project) return toast("Choose a project first");
    const add = list.filter(keep).map((x) => ({ ...x, project, done: 0, state: "waiting", row: null }));
    if (!add.length) return toast("No files found in what you dropped");
    for (const x of add) {
      x.row = document.createElement("div"); x.row.className = "st-up";
      x.row.innerHTML = `<span class="name" title="${esc(x.path)}">${esc(x.path)}</span><div class="st-bar"><span></span></div><span class="st-muted st">waiting</span>`;
      $("upList").appendChild(x.row);
    }
    queue.push(...add);
    pump();
  }
  const drop = $("drop");
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", async (e) => { e.preventDefault(); drop.classList.remove("over"); enqueue(await entriesFromDrop(e.dataTransfer)); });
  $("pickFiles").addEventListener("change", (e) => { enqueue([...e.target.files].map((f) => ({ file: f, path: f.name }))); e.target.value = ""; });
  $("pickFolder").addEventListener("change", (e) => { enqueue([...e.target.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }))); e.target.value = ""; });

  function show(x, state, pct) {
    x.state = state;
    x.row.classList.toggle("err", state.startsWith("failed"));
    x.row.querySelector(".st").textContent = state;
    if (pct !== undefined) x.row.querySelector(".st-bar span").style.width = `${pct}%`;
    overall();
  }
  function overall() {
    const total = queue.reduce((a, x) => a + x.file.size, 0), done = queue.reduce((a, x) => a + x.done, 0);
    const left = queue.filter((x) => !["done", "already there"].includes(x.state) && !x.state.startsWith("failed")).length;
    const failed = queue.filter((x) => x.state.startsWith("failed")).length;
    $("upOverall").innerHTML = queue.length ? `<div class="st-overall">${left ? `Uploading to <b>${esc(queue[0].project)}</b>: ${queue.length - left} of ${queue.length} files` : `<b>All done.</b> ${queue.length - failed} of ${queue.length} files are in the cloud`}${failed ? ` · <span class="err">${failed} failed (drop them again to retry)</span>` : ""}
      · ${mb(done)} of ${mb(total)}<div class="st-bar"><span style="width:${total ? (done / total) * 100 : 0}%"></span></div></div>` : "";
  }

  async function pump() {
    if (!uploading) { try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {} }
    while (uploading < 3) {
      const x = queue.find((q) => q.state === "waiting"); if (!x) break;
      uploading++; x.state = "starting";
      uploadOne(x).catch((err) => show(x, `failed: ${err.message || err}`)).finally(() => {
        uploading--;
        if (!uploading && !queue.some((q) => q.state === "waiting")) { try { wakeLock?.release(); } catch {} listCloud(); }
        pump();
      });
    }
  }
  function put(url, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded);
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve(xhr.getResponseHeader("ETag")) : reject(new Error(`upload error ${xhr.status}`)));
      xhr.onerror = () => reject(new Error("network error"));
      xhr.send(blob);
    });
  }
  async function retry(fn, tries = 4) {
    for (let k = 1; ; k++) {
      try { return await fn(); } catch (e) { if (k >= tries) throw e; await new Promise((r) => setTimeout(r, 1500 * k)); }
    }
  }
  const rawApi = (route, body) => api(`/api/admin/raw/${route}`, { method: "POST", body: JSON.stringify({ project: body.project, ...body }) });

  async function uploadOne(x) {
    const f = x.file, resumeKey = `raw-up:${x.project}/${x.path}:${f.size}:${f.lastModified}`;
    let saved = null; try { saved = JSON.parse(localStorage.getItem(resumeKey) || "null"); } catch {}
    let uploadId = saved?.uploadId, have = {};
    if (uploadId) {
      const r = await rawApi("parts", { project: x.project, path: x.path, uploadId });
      if (r.ok) for (const p of r.body.parts) have[p.n] = p; else uploadId = null;
    }
    if (!uploadId) {
      const s = await rawApi("start", { project: x.project, path: x.path, size: f.size, type: f.type });
      if (!s.ok) throw new Error(s.body.error || "couldn't start");
      if (s.body.done) { x.done = f.size; return show(x, "already there", 100); }
      if (s.body.url) {
        show(x, "uploading", 0);
        await retry(() => put(s.body.url, f, (n) => { x.done = n; show(x, "uploading", Math.round((n / f.size) * 100)); }));
        x.done = f.size; return show(x, "done", 100);
      }
      uploadId = s.body.uploadId;
      try { localStorage.setItem(resumeKey, JSON.stringify({ uploadId })); } catch {}
    }
    // multipart: parts of PART bytes (bigger for very large files, max 10,000 parts)
    const size = Math.max(PART, Math.ceil(f.size / 9500 / 1048576) * 1048576);
    const count = Math.ceil(f.size / size);
    const progress = {};
    for (const n in have) progress[n] = have[n].size;
    const report = () => { x.done = Object.values(progress).reduce((a, b) => a + b, 0); show(x, "uploading", Math.round((x.done / f.size) * 100)); };
    report();
    const todo = []; for (let n = 1; n <= count; n++) if (!have[n]) todo.push(n);
    for (let b = 0; b < todo.length; b += 20) {
      const batch = todo.slice(b, b + 20);
      const u = await rawApi("part-urls", { project: x.project, path: x.path, uploadId, parts: batch });
      if (!u.ok) throw new Error(u.body.error || "couldn't get upload links");
      let next = 0;
      const worker = async () => {
        while (next < batch.length) {
          const n = batch[next++];
          const blob = f.slice((n - 1) * size, Math.min(f.size, n * size));
          const etag = await retry(() => put(u.body.urls[n], blob, (loaded) => { progress[n] = loaded; report(); }));
          if (!etag) throw new Error("storage didn't return a part receipt (CORS ExposeHeaders ETag)");
          have[n] = { n, etag, size: blob.size }; progress[n] = blob.size; report();
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
    }
    show(x, "finishing", 100);
    const c = await rawApi("complete", { project: x.project, path: x.path, uploadId, parts: Object.values(have).map((p) => ({ n: p.n, etag: p.etag })) });
    if (!c.ok) throw new Error(c.body.error || "couldn't finish");
    if (c.body.size !== f.size) throw new Error(`size mismatch in the cloud (${c.body.size} vs ${f.size})`);
    try { localStorage.removeItem(resumeKey); } catch {}
    x.done = f.size; show(x, "done", 100);
  }

  boot();
})();
