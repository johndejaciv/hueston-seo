// Looks up a Notion user by name
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const notionKey = process.env.NOTION_API_KEY;
  if (!notionKey) return res.status(500).json({ error: "NOTION_API_KEY not set" });

  const { name } = req.body;

  try {
    const r = await fetch("https://api.notion.com/v1/users", {
      headers: {
        "Authorization": `Bearer ${notionKey}`,
        "Notion-Version": "2022-06-28",
      },
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.message });

    const users = data.results || [];
    const match = users.find(u =>
      u.name?.toLowerCase().includes(name.toLowerCase()) ||
      u.person?.email?.toLowerCase().includes(name.toLowerCase())
    );

    return res.status(200).json({ user: match || null, users: users.map(u => ({ id: u.id, name: u.name })) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
