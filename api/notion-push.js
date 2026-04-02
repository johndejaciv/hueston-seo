// Calls Notion REST API directly — no MCP needed
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const notionKey = process.env.NOTION_API_KEY;
  if (!notionKey) return res.status(500).json({ error: "NOTION_API_KEY not set" });

  const { dataSourceId, titleProp, dateProp, assigneeProp, assigneeId, title, due, body } = req.body;

  try {
    // Build properties object
    const properties = {
      [titleProp]: { title: [{ text: { content: title } }] },
    };

    if (dateProp) {
      properties[dateProp] = { date: { start: due } };
    }

    if (assigneeProp && assigneeId) {
      properties[assigneeProp] = { people: [{ id: assigneeId }] };
    }

    // Convert markdown body to Notion blocks (simple paragraph blocks)
    const lines = body.split("\n").filter(l => l.trim());
    const blocks = lines.map(line => {
      if (line.startsWith("## ")) {
        return { object: "block", type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: line.replace("## ", "") } }] } };
      }
      if (line.startsWith("- [ ] ")) {
        return { object: "block", type: "to_do", to_do: { rich_text: [{ type: "text", text: { content: line.replace("- [ ] ", "") } }], checked: false } };
      }
      if (line.startsWith("- ")) {
        return { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: line.replace("- ", "") } }] } };
      }
      return { object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: line } }] } };
    });

    const response = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${notionKey}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
      },
      body: JSON.stringify({
        parent: { database_id: dataSourceId },
        properties,
        children: blocks,
      }),
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.message || JSON.stringify(data) });
    return res.status(200).json({ ok: true, pageId: data.id, url: data.url });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
