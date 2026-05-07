import { list } from "@vercel/blob";

let _blobBase = null;
function getBlobBase() {
  if (_blobBase) return _blobBase;
  const token = process.env.BLOB_READ_WRITE_TOKEN || "";
  const m = token.match(/vercel_blob_rw_([A-Za-z0-9]+)/i);
  if (m) _blobBase = `https://${m[1].toLowerCase()}.public.blob.vercel-storage.com`;
  return _blobBase;
}

async function getJson(key) {
  try {
    const base = getBlobBase();
    if (base) {
      const res = await fetch(`${base}/${key}?t=${Date.now()}`, { cache: "no-store" });
      if (res.ok) return await res.json();
      if (res.status === 404) return null;
    }
    const { blobs } = await list({ prefix: key });
    if (!blobs.length) return null;
    const res = await fetch(blobs[0].url);
    return await res.json();
  } catch { return null; }
}

const delay = ms => new Promise(r => setTimeout(r, ms));

function getEndOfMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0];
}

function buildBody(scan) {
  const crit = (scan.issues || []).filter(i => i.priority === "critical");
  const med  = (scan.issues || []).filter(i => i.priority === "medium");
  return [
    "## Summary", scan.summary || "", "",
    "SEO Score: " + scan.score + "/100",
    "Pages audited: " + (scan.pagesAudited || 1), "",
    "## Critical Issues (" + crit.length + ")",
    ...crit.map(i => "- [ ] " + i.label + " — " + i.fix), "",
    "## Medium Issues (" + med.length + ")",
    ...med.map(i => "- [ ] " + i.label + " — " + i.fix), "",
    "## Next Steps",
    "- [ ] Review critical issues and assign to dev/content team",
    "- [ ] Schedule fixes before end of month",
    "- [ ] Re-scan after fixes to verify improvements",
  ].join("\n");
}

export default async function handler(req, res) {
  const sites = (await getJson("sites.json")) || [];
  if (sites.length === 0) return res.status(200).json({ message: "No sites in database yet" });

  const base = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? "https://" + process.env.VERCEL_PROJECT_PRODUCTION_URL
    : process.env.VERCEL_URL
    ? "https://" + process.env.VERCEL_URL
    : "http://localhost:3000";

  const due = getEndOfMonth();
  const results = [];

  for (const url of sites) {
    try {
      // Step 1: Full site crawl (same as frontend)
      const crawlRes = await fetch(base + "/api/crawl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const crawlData = await crawlRes.json();
      if (!crawlRes.ok || crawlData.error) throw new Error("Crawl failed: " + (crawlData.error || crawlRes.status));

      const scan = { ...crawlData, date: new Date().toISOString(), live: true };

      // Step 2: Save scan + update history via sites API
      await fetch(base + "/api/sites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save_scan", url, scan }),
      });

      await delay(3000);

      // Step 3: Push to Notion
      const title = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" }) + " SEO Audit — " + url;
      const pushRes = await fetch(base + "/api/notion-push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, due, body: buildBody(scan) }),
      });
      const pushData = await pushRes.json();
      if (!pushRes.ok) throw new Error("Notion push failed: " + pushData.error);

      results.push({ url, status: "ok", score: scan.score, pages: scan.pagesAudited, notion: "pushed" });
    } catch (e) {
      results.push({ url, status: "error", error: e.message });
    }

    await delay(5000);
  }

  return res.status(200).json({ scanned: results.length, results });
}
