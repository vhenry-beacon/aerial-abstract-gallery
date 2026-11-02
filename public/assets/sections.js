// How photos and clips are grouped, everywhere they're listed (client gallery, My files, review studio).
// Drone footage vs ground (Osmo/handheld) comes from the item's category; horizontal vs vertical from its shape.
window.Sections = (() => {
  const VIDEO = [["video-h", "Horizontal videos"], ["video-v", "Vertical videos"], ["video-gh", "Ground horizontal"], ["video-gv", "Ground vertical"]];
  const PHOTO = [["photo-h", "Horizontal pictures"], ["photo-v", "Vertical pictures"], ["photo-gh", "Ground horizontal"], ["photo-gv", "Ground vertical"]];
  const ALL = [...VIDEO, ...PHOTO];
  const rank = Object.fromEntries(ALL.map(([k], n) => [k, n]));
  const label = Object.fromEntries(ALL);
  const vertical = (it) => it.orientation ? it.orientation === "portrait" : (it.height || 0) > (it.width || 0) || (it.type === "video" && !it.width);
  const of = (it) => `${it.type === "video" ? "video" : "photo"}-${it.category === "ground" ? "g" : ""}${vertical(it) ? "v" : "h"}`;
  // manifest order within a section, sections in the order above
  const sort = (list) => list.map((it, n) => [it, n]).sort((a, b) => rank[of(a[0])] - rank[of(b[0])] || a[1] - b[1]).map((x) => x[0]);
  // [{key, label, items}] for the sections that have something in them
  const groups = (list) => ALL.map(([key, l]) => ({ key, label: l, vertical: key.endsWith("v"), items: list.filter((it) => of(it) === key) })).filter((g) => g.items.length);
  return { of, sort, groups, label };
})();
