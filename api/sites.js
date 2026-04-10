import { put, list } from "@vercel/blob";

const STORE_URL = process.env.BLOB_READ_WRITE_TOKEN
  ? null // will use list()
  : null;

async function getJson(key) {
  try {
    const { blobs } = await list({ prefix: key, limit: 1 });
    if (!blobs.length) return null;
    // Always fetch fresh — add cache-busting param
    const url = blobs[0].url + "?t=" + Date.now();
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
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
      const settings = (await getJson("settings.json")) || {};
      const scans = {};
      await Promise.all(sites.map(async (url) => {
        const scan = await getJson("scan-" + encodeURIComponent(url) + ".json");
        if (scan) scans[url] = scan;
      }));
      return res.status(200).json({ sites, scans, settings });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === "POST") {
    const { action, url, scan, notionLink, notionUser, pushStatus } = req.body;
    try {
      if (action === "add_site") {
        // Retry up to 3 times to handle blob cache staleness
        let sites = [];
        for (let i = 0; i < 3; i++) {
          await new Promise(r => setTimeout(r, i * 200)); // back-off
          sites = (await getJson("sites.json")) || [];
          if (!sites.includes(url)) {
            sites.push(url);
            await putJson("sites.json", sites);
            // Verify the write took by re-reading
            await new Promise(r => setTimeout(r, 300));
            const verify = (await getJson("sites.json")) || [];
            if (verify.includes(url)) break;
          } else {
            break; // already exists
          }
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
        if (!settings[url]) settings[url] = {};
        if (notionLink !== undefined) settings[url].notionLink = notionLink;
        if (notionUser !== undefined) settings[url].notionUser = notionUser;
        if (pushStatus !== undefined) settings[url].pushStatus = pushStatus;
        await putJson("settings.json", settings);
        return res.status(200).json({ ok: true, settings });
      }

      return res.status(400).json({ error: "Unknown action: " + action });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
