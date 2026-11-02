// "Check my drive": before Keri deletes a shoot from her drive, compare every file in a folder she picks with the
// copy in the cloud, byte for byte, without uploading anything. The cloud keeps an MD5 fingerprint (ETag) of each
// upload: the file's MD5, or for big files uploaded in parts, the MD5 of the parts' MD5s plus "-<number of parts>".
// We compute the same from the local file. Library: spark-md5 3.0.2 (MIT). Used by the project page.
window.DriveCheck = ({ project, input, out, reupload }) => {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MiB = 1048576, CHUNK = 16 * MiB;

  // part sizes that give `parts` parts; the uploader's own rule first (uploader.js)
  function partSizes(size, parts) {
    const own = Math.max(16 * MiB, Math.ceil(size / 9500 / MiB) * MiB), out = [own];
    for (let m = 5; m <= 5120 && out.length < 4; m++) if (m * MiB !== own && Math.ceil(size / (m * MiB)) === parts) out.push(m * MiB);
    return out.filter((p) => Math.ceil(size / p) === parts);
  }
  const hex = (bin) => [...bin].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  async function md5Range(file, from, to, onBytes) {
    const h = new SparkMD5.ArrayBuffer();
    for (let at = from; at < to; at += CHUNK) {
      const end = Math.min(to, at + CHUNK);
      h.append(await file.slice(at, end).arrayBuffer());
      onBytes(end - at);
    }
    return h.end(true); // raw 16-byte digest as a binary string
  }
  async function matches(file, etag, onBytes) {
    const [want, parts] = etag.toLowerCase().split("-");
    if (!parts) return hex(await md5Range(file, 0, file.size, onBytes)) === want;
    for (const ps of partSizes(file.size, Number(parts))) {
      let all = "";
      for (let at = 0; at < file.size; at += ps) all += await md5Range(file, at, Math.min(file.size, at + ps), onBytes);
      const buf = new Uint8Array([...all].map((c) => c.charCodeAt(0))).buffer;
      if (SparkMD5.ArrayBuffer.hash(buf) === want) return true;
    }
    return false;
  }
  // cloud files that could be this local file: same path, a "(new copy N)" of it, same path under another
  // top folder, or the same name and size; it's safe if any of them matches byte for byte
  const copyOf = (p) => p.replace(/ \(new copy(?: \d+)?\)(\.[^./]*)?$/, "$1");
  function candidates(cloud, rel, size) {
    const name = rel.split("/").pop();
    const same = (c) => c.size === size && (copyOf(c.path) === rel || rel.endsWith("/" + copyOf(c.path)) || copyOf(c.path).endsWith("/" + rel));
    const out = cloud.filter(same);
    return out.length ? out : cloud.filter((c) => c.size === size && copyOf(c.path).split("/").pop() === name);
  }

  input.addEventListener("change", async () => {
    const local = [...input.files].filter((f) => f.size > 0 && !(f.webkitRelativePath || f.name).split("/").some((s) => s.startsWith(".")));
    input.value = "";
    if (!local.length) { out.innerHTML = `<p class="st-muted">That folder has no files.</p>`; return; }
    out.innerHTML = `<p class="st-muted">Getting the list of cloud files…</p>`;
    const r = await fetch(`/api/admin/raw/list?project=${encodeURIComponent(project)}`, { credentials: "same-origin" });
    if (!r.ok) { out.innerHTML = `<p class="err">Couldn't read the cloud files. Try again.</p>`; return; }
    const cloud = (await r.json()).files;
    const total = local.reduce((a, f) => a + f.size, 0);
    let done = 0;
    const ok = [], missing = [], differ = [], redo = [];
    for (const [k, f] of local.entries()) {
      const rel = f.webkitRelativePath || f.name;
      out.innerHTML = `<p>Checking ${k + 1} of ${local.length}: ${esc(rel)}</p><div class="st-bar"><span style="width:${(done / total) * 100}%"></span></div>`;
      const cs = candidates(cloud, rel, f.size), before = done;
      const tick = (n) => { done += n; out.querySelector(".st-bar span").style.width = `${(Math.min(done, total) / total) * 100}%`; };
      let good = false;
      for (const c of cs) if (c.etag && await matches(f, c.etag, tick)) { good = true; break; }
      const named = cloud.find((c) => c.path === rel || rel.endsWith("/" + c.path));
      if (good) ok.push(rel);
      else if (!cs.length && !named) { missing.push(rel); redo.push({ file: f, path: rel }); }
      else { differ.push(rel); redo.push({ file: f, path: (named || cs[0]).path }); }
      done = before + f.size;
    }
    const list = (xs) => `<ul class="pj-checklist">${xs.slice(0, 50).map((x) => `<li>${esc(x)}</li>`).join("")}${xs.length > 50 ? `<li>…and ${xs.length - 50} more</li>` : ""}</ul>`;
    const allGood = !missing.length && !differ.length;
    out.innerHTML = (allGood
      ? `<div class="pj-cstate ready"><b>✅ Safe to delete</b><p>All ${ok.length} files in that folder are in the cloud and match exactly, byte for byte. You can delete them from your drive.</p></div>`
      : `<div class="pj-cstate problem"><b>⚠️ Not safe to delete yet</b><p>${ok.length} of ${local.length} files match the cloud exactly.</p></div>`)
      + (missing.length ? `<p><b>Not in the cloud (${missing.length}):</b></p>${list(missing)}` : "")
      + (differ.length ? `<p><b>Different from the cloud copy (${differ.length}):</b> the upload may have been cut off.</p>${list(differ)}` : "")
      + (redo.length ? `<button class="btn" type="button" id="dcRedo">Upload these ${redo.length} again</button>
        <p class="st-muted st-small">${differ.length ? "Cloud copies are locked for 90 days as a safety net, so a different file goes up as a new copy beside the old one (“name (new copy).ext”). " : ""}After they finish, run the check again.</p>` : "");
    const b = out.querySelector("#dcRedo");
    if (b) b.onclick = () => { reupload(redo, true); b.disabled = true; b.textContent = "Uploading… (see the list above)"; };
  });
};
