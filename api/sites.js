import { put, list } from "@vercel/blob";

async function getJson(key) {
  try {
    const { blobs } = await list({ prefix: key });
    if (!blobs.length) return null;
    const res = await fetch(blobs[0].url);
    return await res.json();
  } catch { return null; }
}

async function putJson(key, data) {
  await put(key, JSON.stringify(data), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    try {
      const sites = (await getJson("sites.json")) || [];
      const scans = {};
      const settings = (await getJson("settings.json")) || {};
      for (const url of sites) {
        const scan = await getJson("scan-" + encodeURIComponent(url) + ".json");
        if (scan) scans[url] = scan;
      }
      return res.status(200).json({ sites, scans, settings });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === "POST") {
    const { action, url, scan, notionLink, notionUser } = req.body;
    try {
      if (action === "add_site") {
        const sites = (await getJson("sites.json")) || [];
        if (!sites.includes(url)) {
          sites.push(url);
          await putJson("sites.json", sites);
        }
        return res.status(200).json({ ok: true, sites });
      }
      if (action === "save_scan") {
        await putJson("scan-" + encodeURIComponent(url) + ".json", scan);
        return res.status(200).json({ ok: true });
      }
      if (action === "remove_site") {
        const sites = ((await getJson("sites.json")) || []).filter(s => s !== url);
        await putJson("sites.json", sites);
        return res.status(200).json({ ok: true, sites });
      }
      if (action === "save_settings") {
        const settings = (await getJson("settings.json")) || {};
        if (notionLink !== undefined) settings[url] = { ...settings[url], notionLink };
        if (notionUser !== undefined) settings[url] = { ...settings[url], notionUser };
        if (req.body.pushStatus !== undefined) settings[url] = { ...settings[url], pushStatus: req.body.pushStatus };
        await putJson("settings.json", settings);
        return res.status(200).json({ ok: true, settings });
      }
      return res.status(400).json({ error: "Unknown action" });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
