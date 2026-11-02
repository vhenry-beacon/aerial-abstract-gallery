// Raw-file uploader: files or whole folders go straight to R2 under raw/<project>/, keeping folder paths.
// Big files upload in parts (3 files at a time, 4 parts each); an interrupted upload resumes when the
// same file is dropped again. Used by the project page (admin/project).
window.RawUploader = (opts) => {
  const { project, drop, pickFiles, pickFolder, list, overall, cloud, cloudSum } = opts;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const mb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);
  const PART = 16 * 1024 * 1024;
  let uploading = 0, queue = [], wakeLock = null;

  async function api(path, body) {
    const res = await fetch(path, { method: body ? "POST" : "GET", credentials: "same-origin", headers: { "content-type": "application/json" }, body: body ? JSON.stringify({ project, ...body }) : undefined });
    let b = {}; try { b = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, body: b };
  }

  async function listCloud() {
    const r = await api(`/api/admin/raw/list?project=${encodeURIComponent(project)}`);
    if (!r.ok) { cloud.innerHTML = ""; return []; }
    const files = r.body.files.sort((a, b) => a.path.localeCompare(b.path));
    cloudSum.textContent = files.length ? `${files.length} file${files.length === 1 ? "" : "s"} · ${mb(files.reduce((a, f) => a + f.size, 0))}` : "";
    cloud.innerHTML = `<tr><th>File</th><th>Size</th><th>Added</th><th></th></tr>` + (files.map((f) =>
      `<tr><td>${esc(f.path)}</td><td>${mb(f.size)}</td><td>${new Date(f.modified).toLocaleDateString()}</td>
        <td><button class="btn ghost small" data-dl="${esc(f.path)}" type="button">Download</button></td></tr>`).join("")
      || `<tr><td colspan="4" class="st-muted">No files uploaded yet.</td></tr>`);
    opts.onList && opts.onList(files);
    return files;
  }
  cloud.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-dl]"); if (!b) return;
    const r = await api(`/api/admin/raw/url?project=${encodeURIComponent(project)}&path=${encodeURIComponent(b.dataset.dl)}`);
    if (r.ok) location.href = r.body.url; else alert(r.body.error);
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
  function enqueue(items) {
    const add = items.filter(keep).map((x) => ({ ...x, done: 0, state: "waiting", row: null }));
    if (!add.length) return alert("No files found in what you dropped");
    for (const x of add) {
      x.row = document.createElement("div"); x.row.className = "st-up";
      x.row.innerHTML = `<span class="name" title="${esc(x.path)}">${esc(x.path)}</span><div class="st-bar"><span></span></div><span class="st-muted st">waiting</span>`;
      list.appendChild(x.row);
    }
    queue.push(...add);
    pump();
  }
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", async (e) => { e.preventDefault(); drop.classList.remove("over"); enqueue(await entriesFromDrop(e.dataTransfer)); });
  pickFiles.addEventListener("change", (e) => { enqueue([...e.target.files].map((f) => ({ file: f, path: f.name }))); e.target.value = ""; });
  pickFolder.addEventListener("change", (e) => { enqueue([...e.target.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }))); e.target.value = ""; });
  window.addEventListener("beforeunload", (e) => { if (uploading) { e.preventDefault(); e.returnValue = ""; } });

  function show(x, state, pct) {
    x.state = state;
    x.row.classList.toggle("err", state.startsWith("failed"));
    x.row.querySelector(".st").textContent = state;
    if (pct !== undefined) x.row.querySelector(".st-bar span").style.width = `${pct}%`;
    renderOverall();
  }
  function renderOverall() {
    const total = queue.reduce((a, x) => a + x.file.size, 0), done = queue.reduce((a, x) => a + x.done, 0);
    const left = queue.filter((x) => !["done", "already there"].includes(x.state) && !x.state.startsWith("failed")).length;
    const failed = queue.filter((x) => x.state.startsWith("failed")).length;
    overall.innerHTML = queue.length ? `<div class="st-overall">${left ? `Uploading: ${queue.length - left} of ${queue.length} files` : `<b>All done.</b> ${queue.length - failed} of ${queue.length} files are in the cloud. Before deleting them from your drive, use “Check my drive” below`}${failed ? ` · <span class="err">${failed} failed (drop them again to retry)</span>` : ""}
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

  async function uploadOne(x) {
    const f = x.file, resumeKey = `raw-up:${project}/${x.path}:${f.size}:${f.lastModified}`;
    let saved = null; try { saved = JSON.parse(localStorage.getItem(resumeKey) || "null"); } catch {}
    let uploadId = saved?.uploadId, have = {};
    if (uploadId) {
      const r = await api("/api/admin/raw/parts", { path: x.path, uploadId });
      if (r.ok) for (const p of r.body.parts) have[p.n] = p; else uploadId = null;
    }
    if (!uploadId) {
      let s = await api("/api/admin/raw/start", { path: x.path, size: f.size, type: f.type, replace: !!x.replace });
      if (s.ok && s.body.renamed && !s.body.done) {
        // the cloud copy is locked; this goes up as a new copy beside it
        x.path = s.body.renamed; x.replace = false;
        x.row.querySelector(".name").textContent = x.path;
        s = await api("/api/admin/raw/start", { path: x.path, size: f.size, type: f.type });
      }
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
      const u = await api("/api/admin/raw/part-urls", { path: x.path, uploadId, parts: batch });
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
    const c = await api("/api/admin/raw/complete", { path: x.path, uploadId, parts: Object.values(have).map((p) => ({ n: p.n, etag: p.etag })) });
    if (!c.ok) throw new Error(c.body.error || "couldn't finish");
    if (c.body.size !== f.size) throw new Error(`size mismatch in the cloud (${c.body.size} vs ${f.size})`);
    try { localStorage.removeItem(resumeKey); } catch {}
    x.done = f.size; show(x, "done", 100);
  }

  listCloud();
  // replace: upload again even if a file of the same size is already there (the drive check found it differs)
  return { refresh: listCloud, busy: () => uploading > 0, add: (items, replace) => enqueue(items.map((x) => ({ ...x, replace }))) };
};
