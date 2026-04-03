// Direct Notion REST API push — no MCP needed
// Uses ntn_ token format (Notion's new internal integration token)

const DATABASE_ID    = "28110856346681939b49d58f93578143"; // Hueston Tasks
const ASSIGNEE_ID    = "1edd872b-594c-818e-b5fe-000225734adb"; // John DeJac
const CLIENTS_DB_ID  = "28110856-3466-81be-9883-000b0e0f7c88"; // ClientsOS data source

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const notionKey = process.env.NOTION_API_KEY;
  if (!notionKey) return res.status(500).json({ error: "NOTION_API_KEY not set" });

  const { title, due, body } = req.body;
  if (!title) return res.status(400).json({ error: "title is required" });

  const headers = {
    "Authorization": `Bearer ${notionKey}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  };

  try {
    // Test auth first so we get a clear error if token is wrong
    const authTest = await fetch("https://api.notion.com/v1/users/me", { headers });
    if (!authTest.ok) {
      const authErr = await authTest.json();
      return res.status(401).json({ error: "Notion auth failed: " + (authErr.message || authErr.code || JSON.stringify(authErr)) });
    }

    // Convert body text to Notion blocks
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
        parent: { database_id: DATABASE_ID },
        properties: {
          "Task Name": { title: [{ text: { content: title } }] },
          "Date":      { date: { start: due } },
          "Assignee":  { people: [{ id: ASSIGNEE_ID }] },
          "Status":    { status: { name: "To Do" } },
          "Cadence":   { select: { name: "Monthly" } },
        },
        children: blocks,
      }),
    });

    const created = await createRes.json();
    if (!createRes.ok) {
      return res.status(createRes.status).json({
        error: created.message || created.code || JSON.stringify(created),
        details: created
      });
    }

    return res.status(200).json({ ok: true, pageId: created.id, url: created.url });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
