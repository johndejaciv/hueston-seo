export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const notionKey = process.env.NOTION_API_KEY;
  if (!notionKey) return res.status(500).json({ error: "NOTION_API_KEY not set in Vercel env vars" });

  const { notionUrl, title, due, assigneeName, body } = req.body;
  if (!notionUrl) return res.status(400).json({ error: "notionUrl is required" });

  const headers = {
    "Authorization": `Bearer ${notionKey}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  };

  try {
    // Step 1: extract ID from URL
    const idMatch = notionUrl.match(/([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
    if (!idMatch) return res.status(400).json({ error: "Could not extract Notion ID from URL: " + notionUrl });
    const rawId = idMatch[1].replace(/-/g, "");

    // Step 2: try as database, then as page with child database
    let dbId = null;
    let titleProp = "Name";
    let dateProp = null;
    let assigneeProp = null;

    const dbRes = await fetch(`https://api.notion.com/v1/databases/${rawId}`, { headers });
    if (dbRes.ok) {
      const db = await dbRes.json();
      dbId = db.id;
      const props = db.properties || {};
      for (const [name, prop] of Object.entries(props)) {
        if (prop.type === "title") titleProp = name;
        if (prop.type === "date" && !dateProp) dateProp = name;
        if (prop.type === "people" && !assigneeProp) assigneeProp = name;
      }
    } else {
      // Try as page — find first child database
      const childRes = await fetch(`https://api.notion.com/v1/blocks/${rawId}/children?page_size=50`, { headers });
      if (!childRes.ok) {
        const err = await childRes.json();
        return res.status(404).json({ error: "Not a database or accessible page: " + (err.message || childRes.status) });
      }
      const children = await childRes.json();
      const childDb = (children.results || []).find(b => b.type === "child_database");
      if (!childDb) return res.status(404).json({ error: "No database found inside this Notion page" });

      const childDbRes = await fetch(`https://api.notion.com/v1/databases/${childDb.id}`, { headers });
      if (!childDbRes.ok) return res.status(404).json({ error: "Could not access child database" });
      const db = await childDbRes.json();
      dbId = db.id;
      const props = db.properties || {};
      for (const [name, prop] of Object.entries(props)) {
        if (prop.type === "title") titleProp = name;
        if (prop.type === "date" && !dateProp) dateProp = name;
        if (prop.type === "people" && !assigneeProp) assigneeProp = name;
      }
    }

    // Step 3: look up assignee by name if provided
    let assigneeId = null;
    if (assigneeName && assigneeProp) {
      const usersRes = await fetch("https://api.notion.com/v1/users", { headers });
      if (usersRes.ok) {
        const usersData = await usersRes.json();
        const match = (usersData.results || []).find(u =>
          u.name?.toLowerCase().includes(assigneeName.toLowerCase()) ||
          u.person?.email?.toLowerCase().includes(assigneeName.toLowerCase())
        );
        if (match) assigneeId = match.id;
      }
    }

    // Step 4: build properties
    const properties = {
      [titleProp]: { title: [{ text: { content: title } }] },
    };
    if (dateProp) {
      properties[dateProp] = { date: { start: due } };
    }
    if (assigneeProp && assigneeId) {
      properties[assigneeProp] = { people: [{ id: assigneeId }] };
    }

    // Step 5: convert body to Notion blocks
    const blocks = (body || "").split("\n").filter(l => l.trim()).map(line => {
      if (line.startsWith("## ")) return {
        object: "block", type: "heading_2",
        heading_2: { rich_text: [{ type: "text", text: { content: line.replace("## ", "") } }] }
      };
      if (line.startsWith("- [ ] ")) return {
        object: "block", type: "to_do",
        to_do: { rich_text: [{ type: "text", text: { content: line.replace("- [ ] ", "") } }], checked: false }
      };
      if (line.startsWith("- ")) return {
        object: "block", type: "bulleted_list_item",
        bulleted_list_item: { rich_text: [{ type: "text", text: { content: line.replace("- ", "") } }] }
      };
      return {
        object: "block", type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: line } }] }
      };
    });

    // Step 6: create the page
    const createRes = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        parent: { database_id: dbId },
        properties,
        children: blocks,
      }),
    });

    const created = await createRes.json();
    if (!createRes.ok) {
      return res.status(createRes.status).json({
        error: created.message || JSON.stringify(created),
        debug: { dbId, titleProp, dateProp, assigneeProp, properties }
      });
    }

    return res.status(200).json({ ok: true, pageId: created.id, url: created.url });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
