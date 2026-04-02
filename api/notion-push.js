// Pushes SEO audit tasks directly to Hueston Tasks database
// Data source ID and property names are hardcoded from confirmed schema

const DATA_SOURCE_ID = "28110856-3466-810c-9e6e-000bc49d36d5";
const TITLE_PROP     = "Task Name";
const DATE_PROP      = "Date";
const ASSIGNEE_PROP  = "Assignee";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const notionKey = process.env.NOTION_API_KEY;
  if (!notionKey) return res.status(500).json({ error: "NOTION_API_KEY not set" });

  const { title, due, assigneeName, body } = req.body;

  const headers = {
    "Authorization": `Bearer ${notionKey}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  };

  try {
    // Look up assignee by name if provided
    let assigneeId = null;
    if (assigneeName) {
      const usersRes = await fetch("https://api.notion.com/v1/users", { headers });
      if (usersRes.ok) {
        const { results = [] } = await usersRes.json();
        const match = results.find(u =>
          u.name?.toLowerCase().includes(assigneeName.toLowerCase()) ||
          u.person?.email?.toLowerCase().includes(assigneeName.toLowerCase())
        );
        if (match) assigneeId = match.id;
      }
    }

    // Build properties
    const properties = {
      [TITLE_PROP]: { title: [{ text: { content: title } }] },
      [DATE_PROP]:  { date: { start: due } },
    };
    if (assigneeId) {
      properties[ASSIGNEE_PROP] = { people: [{ id: assigneeId }] };
    }

    // Convert markdown to Notion blocks
    const blocks = (body || "").split("\n").filter(l => l.trim()).map(line => {
      if (line.startsWith("## ")) return {
        object: "block", type: "heading_2",
        heading_2: { rich_text: [{ type: "text", text: { content: line.replace(/^## /, "") } }] }
      };
      if (line.startsWith("- [ ] ")) return {
        object: "block", type: "to_do",
        to_do: { rich_text: [{ type: "text", text: { content: line.replace(/^- \[ \] /, "") } }], checked: false }
      };
      if (line.startsWith("- ")) return {
        object: "block", type: "bulleted_list_item",
        bulleted_list_item: { rich_text: [{ type: "text", text: { content: line.replace(/^- /, "") } }] }
      };
      return {
        object: "block", type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: line } }] }
      };
    });

    // Create the page
    const createRes = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        parent: { database_id: DATA_SOURCE_ID },
        properties,
        children: blocks,
      }),
    });

    const created = await createRes.json();
    if (!createRes.ok) {
      return res.status(createRes.status).json({ error: created.message || JSON.stringify(created) });
    }

    return res.status(200).json({ ok: true, pageId: created.id, url: created.url });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
