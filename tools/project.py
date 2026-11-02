#!/usr/bin/env python3
"""Claude's side of Keri's projects (admin home → project page → "Send to Claude").

  project.py list                                   # every project, its status, and whether it was sent to Claude
  project.py show --id smith-wedding                # quote, instructions, Keri's note, uploaded files
  project.py docs --id smith-wedding --to DIR       # the documents the client received (read them with the quote)
  project.py fetch --id smith-wedding --to DIR      # download the raw files (delete DIR when done)
  project.py scaffold --id smith-wedding [--slug S] # clients/<slug>/client.json from the quote + a new access code
  project.py upload-full --slug S --dir DIR [--id P] # full-quality files (clip-01.mp4, photo-01.jpg…) → R2, marked ready
  project.py link --id smith-wedding --slug S       # after deploying: show the gallery on the project page
  project.py note --id smith-wedding --text "…"     # a note from Claude on the project page
  project.py status --id smith-wedding --state working --text "Cutting the clips"   # the status card Keri sees
                                                    # (states: working, problem, waiting; link sets "ready")

fetch, scaffold and upload-full update the status card themselves ("working" + the step).
Typical build: show → fetch → process_photos.py / process_clips.py (see docs/SOP.md) → scaffold →
build_manifest.py → upload-full → deploy → link. Keri then reviews in the studio and publishes.
"""
import argparse, hashlib, json, os, re, secrets, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import studio  # noqa: E402  (Site, R2, env)


def site():
    return studio.Site(slug="", by="Claude")


def call(s, method, path, body=None):
    return s.call(method, path, body, slug=False)


def project(s, pid):
    return call(s, "GET", f"/api/admin/project?id={pid}")["project"]


def money(c):
    return f"${(c or 0) / 100:,.0f}"


def cmd_list(a):
    s = site()
    for p in call(s, "GET", "/api/admin/projects")["projects"]:
        sent = f" · sent to Claude {p['sentToClaudeAt'][:10]}" if p.get("sentToClaudeAt") else ""
        print(f"{p['id']:28} {p['statusLabel']:16} {p['name']}{sent}{' · gallery ' + p['gallerySlug'] if p.get('gallerySlug') else ''}")


def cmd_show(a):
    s = site()
    p = project(s, a.id)
    q = p.get("quote") or {}
    print(f"{p['name']}  [{p['statusLabel']}]")
    print(f"Client: {p['client'].get('name')} <{p['client'].get('email')}> {p['client'].get('phone')}")
    print(f"Event: {p['event'].get('name')} on {p['event'].get('date')} at {p['event'].get('location')}")
    print(f"Quote: {q.get('packageName')} {money(q.get('price'))}, {q.get('included')} included, extras {money(q.get('extraPrice'))}, due {q.get('due')}")
    for ad in q.get("addons", []):
        print(f"   add-on: {ad['name']} {money(ad['price'])} — {ad['description']}")
    print(f"\nQuote details:\n{q.get('description') or '(none)'}")
    print(f"\nInstructions for Claude:\n{p.get('instructions') or '(none)'}")
    if p.get("sentNote"):
        print(f"\nKeri's note when sending: {p['sentNote']}")
    docs = studio.R2().list(f"docs/{a.id}/")
    print(f"\nDocuments the client received ({len(docs)}){': read them with project.py docs' if docs else ''}:")
    for f in docs:
        print(f"   {f['key'][len(f'docs/{a.id}/'):]}  {f['size'] / 1e6:.1f} MB")
    files = studio.R2().list(f"raw/{a.id}/")
    print(f"\nFiles ({len(files)}, {sum(f['size'] for f in files) / 1e9:.2f} GB):")
    for f in files:
        print(f"   {f['key'][len(f'raw/{a.id}/'):]}  {f['size'] / 1e6:.1f} MB")


def cmd_fetch(a):
    set_status(a.id, "working", "Downloading your files from the cloud")
    r2 = studio.R2()
    files = r2.list(f"raw/{a.id}/")
    for f in files:
        rel = f["key"][len(f"raw/{a.id}/"):]
        dest = os.path.join(a.to, rel)
        if os.path.exists(dest) and os.path.getsize(dest) == f["size"]:
            continue
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        studio.log(f"   {rel} ({f['size'] / 1e6:.1f} MB)")
        r2.get(f["key"], dest)
    studio.log(f"{len(files)} files in {a.to}. Delete the folder once the gallery is built.")


def cmd_docs(a):
    """Download the quote documents (agreement, rate sheet, shot list) to read alongside the quote."""
    r2 = studio.R2()
    files = r2.list(f"docs/{a.id}/")
    os.makedirs(a.to, exist_ok=True)
    for f in files:
        dest = os.path.join(a.to, f["key"][len(f"docs/{a.id}/"):])
        r2.get(f["key"], dest)
        studio.log(f"   {dest}")
    studio.log(f"{len(files)} document(s). Every deliverable they promise must be in the gallery or flagged to Keri.")


def cmd_scaffold(a):
    set_status(a.id, "working", "Setting up the client gallery")
    s = site()
    p = project(s, a.id)
    slug = a.slug or p["id"]
    folder = os.path.join(ROOT, "clients", slug)
    if os.path.exists(os.path.join(folder, "client.json")) and not a.force:
        sys.exit(f"clients/{slug}/client.json already exists (use --force to overwrite)")
    q, c, e = p.get("quote") or {}, p.get("client") or {}, p.get("event") or {}
    words = re.sub(r"[^A-Z]", "", "".join(w[0] for w in (c.get("name") or p["name"]).upper().split()))[:4] or "AA"
    code = f"{words}-{''.join(secrets.choice('ABCDEFGHJKLMNPQRSTUVWXYZ23456789') for _ in range(6))}"
    welcome = (f"Thank you for having Aerial Abstract at your {e.get('name') or 'event'}. "
               f"Pick the {q.get('included') or 0} photos and clips included in your {q.get('packageName') or ''} package."
               + (f" Need more? Add extras for {money(q.get('extraPrice'))} each." if q.get("extraPrice") else ""))
    cfg = {
        "slug": slug, "clientName": c.get("name") or p["name"], "eventName": e.get("name") or p["name"],
        "eventDate": e.get("date") or "", "contactName": c.get("name") or "", "contactEmail": c.get("email") or "",
        "accessCodeHash": hashlib.sha256(code.encode()).hexdigest(), "welcome": re.sub(r"\s+", " ", welcome).strip(),
        "provider": {"name": "Aerial Abstract", "person": "Keri Henry", "email": "kerifhenry@gmail.com", "phone": "(713) 705-4798",
                     "website": "https://aerial-abstract.com", "instagram": "@aerialabstract713"},
        "package": {"name": q.get("packageName") or "Package", "price": q.get("price") or 0, "included": q.get("included") or 0, "paidOffline": False},
        "extraPrice": q.get("extraPrice") or 0,
        "upsells": [],
    }
    for ad in q.get("addons", []):
        if "reel" in ad["name"].lower():
            cfg["upsells"].append({"id": "highlight-reel", "name": ad["name"], "price": ad["price"], "description": ad["description"],
                                   "preview": f"/media/{slug}/reel-sample.mp4", "poster": f"/media/{slug}/reel-sample.jpg", "unlocks": "highlight-reel"})
        else:
            studio.log(f"   note: add-on {ad['name']!r} isn't a reel; handle it by hand (Give free / manual order)")
    os.makedirs(folder, exist_ok=True)
    json.dump(cfg, open(os.path.join(folder, "client.json"), "w"), indent=2)
    call(s, "POST", "/api/admin/project", {"id": p["id"], "claude": True, "accessCode": code})
    studio.log(f"clients/{slug}/client.json written; access code saved on the project page (not printed here).")


def cmd_upload_full(a):
    if a.id:
        set_status(a.id, "working", "Uploading the finished full-quality files")
    s, r2 = studio.Site(a.slug, by="Claude"), studio.R2()
    for name in sorted(os.listdir(a.dir)):
        if name.startswith("."):
            continue
        iid, ext = os.path.splitext(name)
        ctype = "video/mp4" if ext.lower() == ".mp4" else "image/jpeg"
        size = r2.put(f"full/{a.slug}/{iid}", os.path.join(a.dir, name), ctype)
        s.call("POST", "/api/admin/upload-done", {"id": iid, "name": name, "type": ctype})
        studio.log(f"   {iid}: {size / 1e6:.1f} MB")


def cmd_link(a):
    s = site()
    call(s, "POST", "/api/admin/project", {"id": a.id, "claude": True, "gallerySlug": a.slug,
                                           "claudeNote": a.text or "The gallery is built. Review each item in the studio, then publish."})
    studio.log(f"{a.id} now shows gallery {a.slug}")


def set_status(pid, state, text=""):
    call(site(), "POST", "/api/admin/project", {"id": pid, "claude": True, "state": state, "stateText": text})


def cmd_status(a):
    set_status(a.id, a.state, a.text or "")
    studio.log(f"{a.id}: {a.state}{' (' + a.text + ')' if a.text else ''}")


def cmd_note(a):
    call(site(), "POST", "/api/admin/project", {"id": a.id, "claude": True, "claudeNote": a.text})
    studio.log("note posted")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["list", "show", "fetch", "scaffold", "upload-full", "link", "note", "status", "docs"])
    ap.add_argument("--state", choices=["working", "problem", "waiting"], default="working")
    ap.add_argument("--id")
    ap.add_argument("--slug")
    ap.add_argument("--to")
    ap.add_argument("--dir")
    ap.add_argument("--text")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    {"list": cmd_list, "show": cmd_show, "fetch": cmd_fetch, "scaffold": cmd_scaffold,
     "upload-full": cmd_upload_full, "link": cmd_link, "note": cmd_note, "status": cmd_status, "docs": cmd_docs}[a.cmd](a)


if __name__ == "__main__":
    main()
