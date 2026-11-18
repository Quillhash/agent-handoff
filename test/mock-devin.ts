import express from "express";

/** Minimal stand-in for the Devin v3 sessions API, recording every call. */
export function startMockDevin(port: number) {
  const app = express();
  app.use(express.json());
  const sessions = new Map<string, { prompt: string; title: string; status: string; messages: { source: string; message: string }[] }>();
  const sent: { session: string; message: string }[] = [];
  let n = 0;
  const base = "/v3/organizations/:org/sessions";
  app.post(base, (req, res) => {
    const id = `devin-mock${++n}`;
    sessions.set(id, { prompt: req.body.prompt, title: req.body.title, status: "running", messages: [{ source: "user", message: req.body.prompt }] });
    res.json({ session_id: id, url: `https://app.devin.ai/sessions/${id.slice(6)}`, status: "new" });
  });
  app.get(`${base}/:id`, (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return void res.status(404).json({ detail: "not found" });
    res.json({ session_id: req.params.id, url: "", status: s.status, status_detail: s.status === "exit" ? "finished" : "working", pull_requests: s.status === "exit" ? [{ pr_url: "https://github.com/Quillhash/demo/pull/9", pr_state: "open" }] : [] });
  });
  app.get(`${base}/:id/messages`, (req, res) => {
    const s = sessions.get(req.params.id);
    res.json({ items: (s?.messages ?? []).map((m, i) => ({ event_id: String(i), created_at: i, ...m })), has_next_page: false });
  });
  app.post(`${base}/:id/messages`, (req, res) => {
    sent.push({ session: req.params.id, message: req.body.message });
    sessions.get(req.params.id)?.messages.push({ source: "user", message: req.body.message });
    res.json({});
  });
  const server = app.listen(port);
  return {
    sessions, sent,
    finish(id: string, message: string) { const s = sessions.get(id)!; s.status = "exit"; s.messages.push({ source: "devin", message }); },
    close: () => server.close(),
  };
}
