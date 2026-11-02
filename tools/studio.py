#!/usr/bin/env python3
"""Apply Keri's review-studio requests (admin/studio) to the real files.

  studio.py status --slug river-oaks                 # what Keri asked for, item by item
  studio.py render --slug river-oaks                 # render every changed request (items + reel)
  studio.py render --slug river-oaks --ids clip-03   # just these items
  studio.py render --slug river-oaks --reel [--music track.mp3]
  studio.py set   --slug river-oaks --id clip-03 [--trim 0.8:3.0] [--speed 0.5] [--look warm]
  studio.py reply --slug river-oaks --id clip-03 --text "Trimmed the first second"   (--id reel for the reel)
  studio.py auto                                     # background job: every gallery, render + publish

Edits always start from the untouched original, kept in R2 at orig/<slug>/<id> (copied from
full/<slug>/<id> the first time an item is edited). Results:
  - full-quality file -> R2 full/<slug>/<id>, and the gallery is told it's ready
  - watermarked preview -> public/media/<slug>/  (manifest/client.json get a ?v= cache-buster)
  - the item goes to "Updated, check it" in the studio, with a note saying what changed
After rendering, rebuild and deploy the site (previews and manifest changed) and commit.

Credentials: ADMIN_PASSWORD and R2_* from the environment, else read with `netlify env:get`.
Requires ffmpeg, Pillow, numpy (use the project's .venv).
"""
import argparse, datetime, hashlib, hmac, http.client, json, os, subprocess, sys, tempfile, time, urllib.parse, urllib.request


HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from looks import look_filter  # noqa: E402
from watermark import watermark_overlay  # noqa: E402

SITE = os.environ.get("GALLERY_SITE", "https://aerial-abstract-gallery.netlify.app")
SMOOTH = "minterpolate=fps=30000/1001:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1"
TITLE_FONT = ("/System/Library/Fonts/Supplemental/Didot.ttc", 0)
LABEL_FONT = ("/System/Library/Fonts/Avenir Next.ttc", 2)  # Demi Bold
PHOTO_PREVIEW_EDGE = 1600
XF = 0.4


def env(k):
    v = os.environ.get(k)
    if not v:
        v = subprocess.run(["netlify", "env:get", k], cwd=ROOT, capture_output=True, text=True).stdout.strip()
        os.environ[k] = v
    if not v:
        sys.exit(f"Missing {k} (set it, or run inside the linked Netlify project)")
    return v


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# ---------------- site API (admin) ----------------
class Site:
    def __init__(self, slug, by="Claude"):
        self.slug = slug
        self.by = by  # "Auto-editor" when run by the background job: its notes don't count as answering Keri
        self.cookie = ""  # kept by hand: the admin cookie is Secure, which a cookie jar won't send to http://localhost
        self.call("POST", "/api/admin/login", {"password": env("ADMIN_PASSWORD")}, slug=False)

    def call(self, method, path, body=None, slug=True):
        url = SITE + path + (("&" if "?" in path else "?") + "slug=" + urllib.parse.quote(self.slug) if slug else "")
        req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                                     headers={"content-type": "application/json", **({"cookie": self.cookie} if self.cookie else {})})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                if sc := r.headers.get("set-cookie"):
                    self.cookie = sc.split(";")[0]
                return json.load(r)
        except urllib.error.HTTPError as e:
            sys.exit(f"{method} {path} failed: {e.code} {e.read().decode()[:200]}")

    def review(self):
        return self.call("GET", "/api/admin/review")

    def post(self, body):
        return self.call("POST", "/api/admin/review", {"by": self.by, **body})["review"]


# ---------------- Cloudflare R2 (S3 SigV4, unsigned payload) ----------------
class R2:
    def __init__(self):
        self.acct, self.kid, self.sec, self.bucket = (env(k) for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"))
        self.host = f"{self.acct}.r2.cloudflarestorage.com"

    def _req(self, method, key, headers=None, body=None, length=None, query=None):
        path = "/" + self.bucket + ("/" + urllib.parse.quote(key, safe="/~") if key else "")
        q = "&".join(f"{urllib.parse.quote(k, safe='~')}={urllib.parse.quote(str(v), safe='~')}" for k, v in sorted((query or {}).items()))
        now = datetime.datetime.now(datetime.timezone.utc)
        amz, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
        h = {**(headers or {}), "host": self.host, "x-amz-date": amz, "x-amz-content-sha256": "UNSIGNED-PAYLOAD"}
        if length is not None:
            h["content-length"] = str(length)
        names = sorted(k.lower() for k in h)
        lower = {k.lower(): str(v).strip() for k, v in h.items()}
        canonical = "\n".join([method, path, q, "".join(f"{k}:{lower[k]}\n" for k in names), ";".join(names), "UNSIGNED-PAYLOAD"])
        scope = f"{day}/auto/s3/aws4_request"
        sts = "\n".join(["AWS4-HMAC-SHA256", amz, scope, hashlib.sha256(canonical.encode()).hexdigest()])
        k = ("AWS4" + self.sec).encode()
        for part in (day, "auto", "s3", "aws4_request"):
            k = hmac.new(k, part.encode(), hashlib.sha256).digest()
        sig = hmac.new(k, sts.encode(), hashlib.sha256).hexdigest()
        h["Authorization"] = f"AWS4-HMAC-SHA256 Credential={self.kid}/{scope}, SignedHeaders={';'.join(names)}, Signature={sig}"
        conn = http.client.HTTPSConnection(self.host, timeout=300)
        conn.request(method, path + (f"?{q}" if q else ""), body=body, headers=h)
        return conn, conn.getresponse()

    def list(self, prefix):
        """[{key, size}] under a prefix (ListObjectsV2, all pages)."""
        import re
        out, token = [], None
        while True:
            q = {"list-type": "2", "prefix": prefix, **({"continuation-token": token} if token else {})}
            conn, r = self._req("GET", "", query=q)
            xml = r.read().decode(); conn.close()
            if r.status != 200:
                sys.exit(f"listing {prefix} failed: {r.status} {xml[:200]}")
            for m in re.finditer(r"<Contents>(.*?)</Contents>", xml, re.S):
                out.append({"key": re.search(r"<Key>(.*?)</Key>", m.group(1)).group(1).replace("&amp;", "&"),
                            "size": int(re.search(r"<Size>(\d+)</Size>", m.group(1)).group(1))})
            t = re.search(r"<NextContinuationToken>(.*?)</NextContinuationToken>", xml)
            if "<IsTruncated>true</IsTruncated>" not in xml or not t:
                return out
            token = t.group(1)

    def head(self, key):
        conn, r = self._req("HEAD", key)
        r.read(); conn.close()
        return {"size": int(r.getheader("content-length") or 0), "etag": (r.getheader("etag") or "").strip('"')} if r.status == 200 else None

    def get(self, key, dest):
        conn, r = self._req("GET", key)
        if r.status != 200:
            sys.exit(f"download {key} failed: {r.status} {r.read()[:200]}")
        with open(dest, "wb") as f:
            while chunk := r.read(1 << 20):
                f.write(chunk)
        conn.close()

    def put(self, key, path, content_type):
        md5 = hashlib.md5(open(path, "rb").read()).hexdigest()
        size = os.path.getsize(path)
        for attempt in range(1, 11):
            if attempt > 1:
                time.sleep(min(30, 3 * attempt))  # dropped connections come in bursts; wait them out
            try:
                with open(path, "rb") as f:
                    conn, r = self._req("PUT", key, {"content-type": content_type}, body=f, length=size)
                    r.read(); conn.close()
                h = self.head(key)
                if r.status == 200 and h and h["etag"] == md5 and h["size"] == size:
                    return size
                log(f"   upload check failed (attempt {attempt}), retrying")
            except OSError as e:
                log(f"   upload dropped ({e}), retrying")
        sys.exit(f"upload of {key} failed")

    def copy(self, src, dst):
        conn, r = self._req("PUT", dst, {"x-amz-copy-source": f"/{self.bucket}/{urllib.parse.quote(src, safe='/~')}"})
        body = r.read(); conn.close()
        if r.status != 200 or b"<Error>" in body:
            sys.exit(f"copy {src} -> {dst} failed: {r.status} {body[:200]}")


# ---------------- helpers ----------------
def run(cmd):
    p = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if p.returncode:
        sys.exit(f"ffmpeg failed:\n{p.stderr[-1500:]}")


def probe(path):
    d = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries",
                                            "stream=codec_type,width,height:format=duration", "-of", "json", path]))
    v = next(s for s in d["streams"] if s["codec_type"] == "video")
    return {"w": v["width"], "h": v["height"], "dur": float(d["format"]["duration"]),
            "audio": any(s["codec_type"] == "audio" for s in d["streams"])}


def atempo(speed):
    out, s = [], speed
    while s > 2.0:
        out.append("atempo=2.0"); s /= 2.0
    while s < 0.5:
        out.append("atempo=0.5"); s /= 0.5
    out.append(f"atempo={s:.4f}")
    return ",".join(out)


def describe(edit, item):
    if not edit:
        return "back to the original"
    bits = []
    look = edit.get("look") or {}
    if look_filter(look):
        name = look.get("preset", "original")
        tweaks = [k for k in ("brightness", "contrast", "saturation", "warmth", "fade") if abs(look.get(k) or 0) >= 0.005]
        bits.append(("look " + name if name != "original" else "color") + (f" (adjusted {', '.join(tweaks)})" if tweaks else ""))
    if item["type"] == "video":
        if edit.get("trim"):
            bits.append(f"trimmed to {edit['trim'][0]:.1f}s-{edit['trim'][1]:.1f}s")
        if edit.get("speed", 1) != 1:
            s = edit["speed"]
            bits.append(f"{s}x {'slow motion (smoothed)' if s < 1 else 'speed'}")
    return ", ".join(bits) or "no visible change"


def ver_url(url, v):
    return url.split("?")[0] + (f"?v={v}" if v else "")


def manifest_path(slug):
    return os.path.join(ROOT, "clients", slug, "manifest.json")


def ensure_original(r2, slug, item_id, cache):
    """Download the untouched original (creating orig/ from full/ on first edit)."""
    if item_id in cache:
        return cache[item_id]
    okey, fkey = f"orig/{slug}/{item_id}", f"full/{slug}/{item_id}"
    if not r2.head(okey):
        if not r2.head(fkey):
            sys.exit(f"{item_id}: no full-quality file in storage yet")
        r2.copy(fkey, okey)
        log(f"   kept the original as {okey}")
    dest = os.path.join(cache["_dir"], item_id)
    r2.get(okey, dest)
    cache[item_id] = dest
    return dest


# ---------------- items ----------------
def render_video(src, edit, out):
    info = probe(src)
    t0, t1 = (edit or {}).get("trim") or (0, info["dur"])
    speed = (edit or {}).get("speed", 1) or 1
    vf = []
    if speed != 1:
        vf.append(f"setpts=PTS/{speed}")
        if speed < 1:
            vf.append(SMOOTH)
    if lf := look_filter((edit or {}).get("look")):
        vf.append(lf)
    vf.append("format=yuv420p")
    # no trim: take the whole file (a seconds-based -t here dropped the last frame of some clips)
    span = ["-ss", f"{t0}", "-t", f"{t1 - t0}"] if (edit or {}).get("trim") else []
    cmd = ["ffmpeg", "-y", *span, "-i", src, "-map", "0:v:0", "-vf", ",".join(vf),
           "-c:v", "libx264", "-preset", "medium", "-crf", "16"]
    if info["audio"]:
        cmd += ["-map", "0:a:0", "-c:a", "aac", "-b:a", "192k"] + (["-af", atempo(speed)] if speed != 1 else [])
    if speed < 1:
        # measured on an M1 Max: ~25 s of work per second of 4K output
        log(f"   smoothing slow motion: about {max(1, round((t1 - t0) / speed * 25 / 60))} min for this clip")
    run(cmd + ["-movflags", "+faststart", out])
    return probe(out)


def video_preview(full, info, prev_mp4, prev_jpg):
    pw = 540 if info["h"] > info["w"] else 960
    ph = int(round(info["h"] * pw / info["w"] / 2) * 2)
    with tempfile.TemporaryDirectory() as td:
        wm = os.path.join(td, "wm.png")
        watermark_overlay(pw, ph).save(wm)
        run(["ffmpeg", "-y", "-i", full, "-i", wm, "-filter_complex", f"[0:v]scale={pw}:{ph},fps=30[v];[v][1:v]overlay=0:0",
             "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p", "-movflags", "+faststart", prev_mp4])
    run(["ffmpeg", "-y", "-ss", f"{min(1.0, info['dur'] / 2)}", "-i", prev_mp4, "-frames:v", "1", "-q:v", "4", prev_jpg])


def render_photo(src, edit, out, prev_jpg):
    from PIL import Image
    exif = Image.open(src).info.get("exif")
    lf = look_filter((edit or {}).get("look"))
    if lf:
        with tempfile.TemporaryDirectory() as td:
            png = os.path.join(td, "x.png")
            run(["ffmpeg", "-y", "-i", src, "-vf", lf, png])
            im = Image.open(png).convert("RGB")
    else:
        im = Image.open(src).convert("RGB")
    im.save(out, "JPEG", quality=94, subsampling=0, **({"exif": exif} if exif else {}))
    pv = im.copy()
    pv.thumbnail((PHOTO_PREVIEW_EDGE, PHOTO_PREVIEW_EDGE), Image.LANCZOS)
    pv = Image.alpha_composite(pv.convert("RGBA"), watermark_overlay(pv.width, pv.height)).convert("RGB")
    pv.save(prev_jpg, "JPEG", quality=72, progressive=True)


def render_items(site, r2, data, ids, cache):
    review, items = data["review"], {i["id"]: i for i in data["items"]}
    man = json.load(open(manifest_path(site.slug)))
    media = os.path.join(ROOT, "public", "media", site.slug)
    done = []
    for iid in ids:
        it, rv = items[iid], review["items"].get(iid) or {}
        edit, version = rv.get("edit"), (rv.get("version") or 0) + 1
        log(f"{iid}: {describe(edit, it)}")
        src = ensure_original(r2, site.slug, iid, cache)
        ext, ctype = ("mp4", "video/mp4") if it["type"] == "video" else ("jpg", "image/jpeg")
        out = os.path.join(cache["_dir"], f"{iid}.out.{ext}")
        original = describe(edit, it) in ("back to the original", "no visible change")
        if it["type"] == "video":
            info = probe(src) if original else render_video(src, edit, out)
            video_preview(src if original else out, info, os.path.join(media, f"{iid}.mp4"), os.path.join(media, f"{iid}.jpg"))
        else:
            render_photo(src, edit, out, os.path.join(media, f"{iid}.jpg"))
        if original:  # restore the untouched file byte for byte
            r2.copy(f"orig/{site.slug}/{iid}", f"full/{site.slug}/{iid}")
            size = os.path.getsize(src)
        else:
            size = r2.put(f"full/{site.slug}/{iid}", out, ctype)
        site.call("POST", "/api/admin/upload-done", {"id": iid, "name": it.get("fullFile") or f"{iid}.{ext}", "type": ctype})
        for m in man["items"]:
            if m["id"] == iid:
                m["preview"] = ver_url(m["preview"], version)
                if it["type"] == "video":
                    m["poster"] = ver_url(m["poster"], version)
                    m["duration"] = round(info["dur"], 2)
        site.post({"id": iid, "status": "revised", "version": version, "rendered": edit,
                   "note": {"text": f"Updated: {describe(edit, it)}. Take a look and approve it, or leave another note."}})
        log(f"   done: {size / 1e6:.1f} MB uploaded, preview v{version}")
        done.append(iid)
    json.dump(man, open(manifest_path(site.slug), "w"), indent=2)
    return done


# ---------------- highlight reel ----------------
def text_card(w, h, title, subtitle, y_frac):
    from PIL import Image, ImageDraw, ImageFont
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    tf = ImageFont.truetype(TITLE_FONT[0], int(w / 8.5), index=TITLE_FONT[1])
    sf = ImageFont.truetype(LABEL_FONT[0], int(w / 26), index=LABEL_FONT[1])
    y = int(h * y_frac)

    def centered(text, font, y, spacing=0):
        if spacing:
            chars = list(text)
            widths = [d.textlength(c, font=font) for c in chars]
            x = (w - (sum(widths) + spacing * (len(chars) - 1))) / 2
            for c, cw in zip(chars, widths):
                for dx, dy, col in ((3, 3, (0, 0, 0, 120)), (0, 0, (255, 255, 255, 255))):
                    d.text((x + dx, y + dy), c, font=font, fill=col)
                x += cw + spacing
        else:
            x = (w - d.textlength(text, font=font)) / 2
            d.text((x + 3, y + 3), text, font=font, fill=(0, 0, 0, 120))
            d.text((x, y), text, font=font, fill=(255, 255, 255, 255))

    if title:
        centered(title, tf, y)
        y += int(tf.size * 1.25)
    if subtitle:
        centered(subtitle.upper(), sf, y, spacing=int(sf.size * 0.18))
    return im


def render_reel(site, r2, data, cache, music=None):
    reel, items = data["review"]["reel"], {i["id"]: i for i in data["items"]}
    pieces = reel["pieces"]
    if not pieces:
        sys.exit("The reel has no pieces")
    W, H = 1080, 1920
    lens = [(p["out"] - p["in"]) / (p.get("speed") or 1) for p in pieces]
    fade = reel.get("transition", "fade") == "fade"
    total = sum(lens) - (XF * (len(pieces) - 1) if fade else 0)
    log(f"reel: {len(pieces)} pieces, {total:.1f}s, {'crossfades' if fade else 'hard cuts'}")
    inputs, chains = [], []
    for k, p in enumerate(pieces):
        src = ensure_original(r2, site.slug, p["clip"], cache)
        inputs += ["-ss", f"{p['in']}", "-t", f"{p['out'] - p['in']}", "-i", src]
        speed = p.get("speed") or 1
        f = [f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}"]
        if speed != 1:
            f.append(f"setpts=PTS/{speed}")
            if speed < 1:
                f.append(SMOOTH)
        f.append("fps=30")
        if lf := look_filter(p.get("look") or reel.get("look")):
            f.append(lf)
        chains.append(f"[{k}:v]{','.join(f)},format=yuv420p,setpts=PTS-STARTPTS[v{k}]")
    if fade and len(pieces) > 1:
        last, off = "v0", lens[0]
        for k in range(1, len(pieces)):
            off -= XF
            chains.append(f"[{last}][v{k}]xfade=transition=fade:duration={XF}:offset={off:.3f}[x{k}]")
            last, off = f"x{k}", off + lens[k]
    else:
        chains.append("".join(f"[v{k}]" for k in range(len(pieces))) + f"concat=n={len(pieces)}:v=1:a=0[x]")
        last = "x"
    with tempfile.TemporaryDirectory() as td:
        n = len(pieces)
        title_png, end_png = os.path.join(td, "title.png"), os.path.join(td, "end.png")
        text_card(W, H, reel.get("title", ""), reel.get("subtitle", ""), 0.40).save(title_png)
        text_card(W, H, "", reel.get("endcard", ""), 0.46).save(end_png)
        inputs += ["-loop", "1", "-t", f"{total:.2f}", "-i", title_png, "-loop", "1", "-t", f"{total:.2f}", "-i", end_png]
        chains.append(f"[{n}:v]format=rgba,fade=t=in:st=0:d=0.4:alpha=1,fade=t=out:st=3.6:d=0.6:alpha=1[t]")
        chains.append(f"[{n + 1}:v]format=rgba,fade=t=in:st={max(0, total - 3.2):.2f}:d=0.5:alpha=1[e]")
        chains.append(f"[{last}][t]overlay=0:0:enable='lt(t,4.2)'[o1]")
        # the closing card is transparent when there's no closing text
        chains.append(f"[o1][e]overlay=0:0:enable='gte(t,{max(0, total - 3.2):.2f})',fade=t=out:st={total - 0.6:.2f}:d=0.6[vout]")
        full = os.path.join(cache["_dir"], "highlight-reel.mp4")
        cmd = ["ffmpeg", "-y", *inputs]
        maps = ["-map", "[vout]"]
        if music:
            cmd += ["-i", music]
            chains.append(f"[{n + 2}:a]atrim=0:{total:.2f},afade=t=in:d=0.5,afade=t=out:st={total - 1.5:.2f}:d=1.5[aout]")
            maps += ["-map", "[aout]", "-c:a", "aac", "-b:a", "192k"]
        if any((p.get("speed") or 1) < 1 for p in pieces):
            log("   smoothing slow-motion pieces: this takes a few minutes")
        run(cmd + ["-filter_complex", ";".join(chains), *maps, "-c:v", "libx264", "-preset", "medium", "-crf", "17",
                   "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-t", f"{total:.2f}", full])
        # watermarked preview for the gallery and studio
        media = os.path.join(ROOT, "public", "media", site.slug)
        prev = os.path.join(media, "reel-sample.mp4")
        wm = os.path.join(td, "wm.png")
        watermark_overlay(540, 960, center_y=0.72).save(wm)
        run(["ffmpeg", "-y", "-i", full, "-i", wm, "-filter_complex", "[0:v]scale=540:960[v];[v][1:v]overlay=0:0",
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
             *(["-c:a", "aac", "-b:a", "96k"] if music else ["-an"]), prev])
        run(["ffmpeg", "-y", "-ss", "1.6", "-i", prev, "-frames:v", "1", "-q:v", "4", os.path.join(media, "reel-sample.jpg")])
        version = (reel.get("version") or 0) + 1
        cpath = os.path.join(ROOT, "clients", site.slug, "client.json")
        client = json.load(open(cpath))
        for u in client.get("upsells", []):
            if u["id"] == "highlight-reel":
                u["preview"], u["poster"] = ver_url(u["preview"], version), ver_url(u["poster"], version)
        json.dump(client, open(cpath, "w"), indent=2)
        msg = f"Updated the reel: {n} pieces, {total:.0f} seconds."
        if music:
            r2.put(f"full/{site.slug}/highlight-reel", full, "video/mp4")
            site.call("POST", "/api/admin/upload-done", {"id": "highlight-reel", "name": f"{site.slug}-highlight-reel.mp4", "type": "video/mp4"})
            msg += " Music added; the full-quality reel is ready for the client."
        else:
            msg += " No music yet: add a licensed track before it can be delivered."
        site.post({"reelStatus": "revised", "reelVersion": version, "reelRendered": reel, "reelNote": {"text": msg}})
        log(f"   done: preview v{version}, {os.path.getsize(full) / 1e6:.1f} MB full reel {'uploaded' if music else '(not uploaded: no music)'}")


# ---------------- commands ----------------
def pending(data):
    """Items whose saved edit differs from what the delivered file reflects."""
    out = []
    for it in data["items"]:
        rv = data["review"]["items"].get(it["id"])
        if not rv or it.get("upsellOnly"):
            continue
        rendered = (rv.get("rendered") or {}).get("edit") if rv.get("rendered") else None
        if json.dumps(rv.get("edit"), sort_keys=True) != json.dumps(rendered, sort_keys=True):
            out.append(it["id"])
    return out


REEL_KEYS = ("pieces", "look", "title", "subtitle", "endcard", "transition", "music")


def reel_changed(reel):
    """The saved reel plan differs from the last rendered one (compared after the server's clean-up)."""
    if not reel:
        return False
    return json.dumps((reel.get("rendered") or {}).get("plan"), sort_keys=True) != json.dumps({k: reel.get(k) for k in REEL_KEYS}, sort_keys=True)


def cmd_status(site):
    data = site.review()
    rv = data["review"]
    print(f"{data['client']['clientName']} · {data['client']['eventName']} — {'PUBLISHED' if rv['published'] else 'not published'}")
    todo = set(pending(data))
    for it in data["items"]:
        r = rv["items"].get(it["id"])
        if it.get("upsellOnly") or not r:
            continue
        flags = " [edit to render]" if it["id"] in todo else ""
        print(f"\n{it['id']} ({it['title']}): {r['status']}{flags}")
        if r.get("edit"):
            print(f"   edit: {describe(r['edit'], it)}")
        for n in r.get("notes", []):
            t = f"@{n['t']:.1f}s " if n.get("t") is not None else ""
            print(f"   {n['by']}: {t}{n['text']}")
    untouched = [i["id"] for i in data["items"] if not i.get("upsellOnly") and i["id"] not in rv["items"]]
    if untouched:
        print(f"\nNot reviewed yet: {', '.join(untouched)}")
    reel = rv.get("reel")
    if reel:
        changed = reel_changed(reel)
        print(f"\nREEL: {reel['status']}{' [plan changed, render it]' if changed else ''} — {len(reel['pieces'])} pieces, "
              f"title {reel.get('title')!r}, music {reel.get('music') or 'none'!r}")
        for k, p in enumerate(reel["pieces"]):
            print(f"   {k + 1}. {p['clip']} {p['in']:.2f}-{p['out']:.2f}s x{p.get('speed', 1)}{' look ' + p['look']['preset'] if p.get('look') else ''}")
        for n in reel.get("notes", []):
            t = f"@{n['t']:.1f}s " if n.get("t") is not None else ""
            print(f"   {n['by']}: {t}{n['text']}")


def cmd_auto():
    """Background job (tools/autorender.sh, every 15 min): render every gallery's waiting requests, publish, report."""
    import fcntl, socket
    lock = open(os.path.join(tempfile.gettempdir(), "aerial-abstract-autorender.lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return log("Another auto-render is still running; skipping this round.")
    slugs = sorted(d for d in os.listdir(os.path.join(ROOT, "clients")) if os.path.exists(os.path.join(ROOT, "clients", d, "client.json")))
    rendered, error, site = [], "", None
    try:
        for slug in slugs:
            site = Site(slug, by="Auto-editor")
            data = site.review()
            ids, do_reel = pending(data), reel_changed(data["review"].get("reel"))
            if not ids and not do_reel:
                continue
            log(f"{slug}: {len(ids)} item(s){' + reel' if do_reel else ''}")
            with tempfile.TemporaryDirectory() as td:
                cache = {"_dir": td}
                r2 = R2()
                if ids:
                    render_items(site, r2, data, ids, cache)
                if do_reel:
                    render_reel(site, r2, site.review(), cache)
            rendered += [f"{slug}/{i}" for i in ids] + ([f"{slug}/reel"] if do_reel else [])
        if rendered:
            for cmd in (["npm", "run", "build"], ["netlify", "deploy", "--prod", "--build"]):
                p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
                if p.returncode:
                    raise RuntimeError(f"{' '.join(cmd)} failed: {(p.stderr or p.stdout)[-300:]}")
            # local save point only; pushing to GitHub happens in a normal Claude session
            subprocess.run(["git", "add", "clients", "public/media", "lib/registry.generated.mjs"], cwd=ROOT)
            subprocess.run(["git", "commit", "-q", "-m", "Auto-editor: " + ", ".join(rendered)[:200]], cwd=ROOT)
            log(f"published: {', '.join(rendered)}")
    except (SystemExit, Exception) as e:  # studio.py helpers exit on errors; report them instead of dying silently
        error = str(e) or repr(e)
        log(f"error: {error}")
    finally:
        try:
            (site or Site(slugs[0], by="Auto-editor")).call("POST", "/api/admin/worker",
                {"rendered": rendered, "error": error, "host": socket.gethostname()}, slug=False)
        except BaseException as e:
            log(f"couldn't report to the site: {e}")


def main():
    global SITE
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["status", "render", "set", "reply", "auto"])
    ap.add_argument("--slug")
    ap.add_argument("--site", default=SITE)
    ap.add_argument("--ids", default="")
    ap.add_argument("--id", default="")
    ap.add_argument("--reel", action="store_true")
    ap.add_argument("--music")
    ap.add_argument("--trim")
    ap.add_argument("--speed", type=float)
    ap.add_argument("--look")
    ap.add_argument("--text")
    a = ap.parse_args()
    SITE = a.site
    if a.cmd == "auto":
        return cmd_auto()
    if not a.slug:
        ap.error("--slug is required")
    site = Site(a.slug)
    if a.cmd == "status":
        return cmd_status(site)
    if a.cmd == "reply":
        body = {"reelNote": {"text": a.text}} if a.id == "reel" else {"id": a.id, "note": {"text": a.text}}
        site.post(body)
        return log("note posted")
    data = site.review()
    if a.cmd == "set":
        cur = (data["review"]["items"].get(a.id) or {}).get("edit") or {}
        edit = {"look": cur.get("look"), "speed": cur.get("speed", 1), "trim": cur.get("trim")}
        if a.trim:
            edit["trim"] = [float(x) for x in a.trim.split(":")]
        if a.speed:
            edit["speed"] = a.speed
        if a.look:
            edit["look"] = {**(edit["look"] or {}), "preset": a.look}
        site.post({"id": a.id, "edit": edit})
        return log(f"{a.id}: edit set to {edit}")
    # render
    # default: every changed item request, plus the reel if its plan changed. --ids limits it to those items.
    ids = [x for x in a.ids.split(",") if x] or pending(data)
    do_reel = a.reel or (not a.ids and reel_changed(data["review"].get("reel")))
    if not ids and not do_reel:
        return log("Nothing to render: no edit requests have changed.")
    with tempfile.TemporaryDirectory() as td:
        cache = {"_dir": td}
        r2 = R2()
        if ids:
            render_items(site, r2, data, ids, cache)
        if do_reel:
            render_reel(site, r2, site.review(), cache, a.music)
    log("Next: npm run build, deploy, and commit the changed previews/manifest.")


if __name__ == "__main__":
    main()
