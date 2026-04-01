import { put, get, list } from "@vercel/blob";

async function getSites() {
  try {
    const { blobs } = await list({ prefix: "sites.json" });
    if (!blobs.length) return [];
    const res = await fetch(blobs[0].url);
    return await res.json();
  } catch { return []; }
}

async function saveSites(sites) {
  await put("sites.json", JSON.stringify(sites), { access: "public", addRandomSuffix: false });
}

async function getScan(url) {
  try {
    const key = "scan-" + encodeURIComponent(url) + ".json";
    const { blobs } = await list({ prefix: key });
    if (!blobs.length) return null;
    const res = await fetch(blobs[0].url);
    return await res.json();
  } catch { return null; }
}

async function saveScan(url, scan) {
  const key = "scan-" + encodeURIComponent(url) + ".json";
  await put(key, JSON.stringify(scan), { access: "public", addRandomSuffix: false });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    try {
      const sites = await getSites();
      const scans = {};
      for (const url of sites) {
        const scan = await getScan(url);
        if (scan) scans[url] = scan;
      }
      return res.status(200).json({ sites, scans });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === "POST") {
    const { action, url, scan } = req.body;
    try {
      if (action === "add_site") {
        const sites = await getSites();
        if (!sites.includes(url)) {
          sites.push(url);
          await saveSites(sites);
        }
        return res.status(200).json({ ok: true, sites });
      }
      if (action === "save_scan") {
        await saveScan(url, scan);
        return res.status(200).json({ ok: true });
      }
      if (action === "remove_site") {
        const sites = (await getSites()).filter(s => s !== url);
        await saveSites(sites);
        return res.status(200).json({ ok: true, sites });
      }
      return res.status(400).json({ error: "Unknown action" });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
