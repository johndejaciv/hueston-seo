import { put, list } from "@vercel/blob";

// Saves push jobs to blob — Claude processes them via scheduled endpoint
async function putJson(key, data) {
  await put(key, JSON.stringify(data), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

async function getJson(key) {
  try {
    const { blobs } = await list({ prefix: key });
    if (!blobs.length) return null;
    const res = await fetch(blobs[0].url);
    return await res.json();
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // POST — queue a new push job
  if (req.method === "POST") {
    const { title, due, body, siteUrl } = req.body;
    const jobs = (await getJson("notion-jobs.json")) || [];
    jobs.push({ id: Date.now(), title, due, body, siteUrl, status: "pending", createdAt: new Date().toISOString() });
    await putJson("notion-jobs.json", jobs);
    return res.status(200).json({ ok: true, message: "Queued for Notion push", queued: jobs.filter(j => j.status === "pending").length });
  }

  // GET — return all jobs (for processing)
  if (req.method === "GET") {
    const jobs = (await getJson("notion-jobs.json")) || [];
    return res.status(200).json({ jobs });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
