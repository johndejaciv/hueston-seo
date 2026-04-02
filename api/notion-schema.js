// Fetches Notion database schema via REST API to discover property names
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const notionKey = process.env.NOTION_API_KEY;
  if (!notionKey) return res.status(500).json({ error: "NOTION_API_KEY not set" });

  const { notionUrl } = req.body;

  // Extract ID from URL
  const match = notionUrl.match(/([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  if (!match) return res.status(400).json({ error: "Could not extract Notion ID from URL" });
  const id = match[1].replace(/-/g, "");

  const headers = {
    "Authorization": `Bearer ${notionKey}`,
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
  };

  try {
    // Try as database first
    let dbRes = await fetch(`https://api.notion.com/v1/databases/${id}`, { headers });

    // If not a database, try as page and search for child databases
    if (!dbRes.ok) {
      const childRes = await fetch(`https://api.notion.com/v1/blocks/${id}/children`, { headers });
      if (!childRes.ok) return res.status(404).json({ error: "Could not find a Notion database at this URL" });

      const children = await childRes.json();
      const childDb = children.results?.find(b => b.type === "child_database");
      if (!childDb) return res.status(404).json({ error: "No database found in this Notion page" });

      dbRes = await fetch(`https://api.notion.com/v1/databases/${childDb.id}`, { headers });
    }

    const db = await dbRes.json();
    if (!dbRes.ok) return res.status(dbRes.status).json({ error: db.message });

    const props = db.properties || {};

    // Find title, date, and people properties
    let titleProp = null, dateProp = null, assigneeProp = null;
    for (const [name, prop] of Object.entries(props)) {
      if (prop.type === "title") titleProp = name;
      if (prop.type === "date" && !dateProp) dateProp = name;
      if (prop.type === "people" && !assigneeProp) assigneeProp = name;
    }

    return res.status(200).json({
      dataSourceId: db.id,
      titleProp,
      dateProp,
      assigneeProp,
      allProps: Object.fromEntries(Object.entries(props).map(([k,v])=>[k,v.type])),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
