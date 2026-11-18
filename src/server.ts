#!/usr/bin/env node
import express, { type Request, type Response, type NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { Store } from "./store.js";
import { DevinClient } from "./devin.js";
import { Hub } from "./hub.js";

const AGENTS = ["claude", "devin", "codex"] as const;
const STATUSES = ["queued", "claimed", "in_progress", "done", "failed", "cancelled"] as const;

/** AGENT_TOKENS="claude=<token>,devin=<token>,runner=<token>" maps each bearer token to who is calling. */
function parseTokens(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = pair.indexOf("=");
    if (i > 0) map.set(pair.slice(i + 1).trim(), pair.slice(0, i).trim());
  }
  return map;
}

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

function summary(h: { id: string; from_agent: string; to_agent: string; status: string; title: string; updated_at: string; devin_session_url?: string | null; pr_url?: string | null }) {
  return {
    id: h.id, from: h.from_agent, to: h.to_agent, status: h.status, title: h.title, updated_at: h.updated_at,
    ...(h.devin_session_url ? { devin_session_url: h.devin_session_url } : {}),
    ...(h.pr_url ? { pr_url: h.pr_url } : {}),
  };
}

export function buildMcp(hub: Hub, caller: string): McpServer {
  const server = new McpServer({ name: "agent-handoff", version: "0.1.0" });

  server.registerTool("handoff_create", {
    title: "Hand off a task",
    description:
      "Hand a task to another agent. to='devin' starts a Devin cloud session now; to='claude' or 'codex' queues it for the owner's local machine, " +
      "where the handoff runner picks it up while the machine is online; to='auto' picks local Claude when its runner is online with usage left, otherwise Devin. " +
      "Put everything the other agent needs in prompt/context (it does not see your conversation). Devin callers: pass your own devin_session_id so the hub messages you the result (if that message does not arrive, poll handoff_get).",
    inputSchema: {
      to: z.enum(["claude", "devin", "codex", "auto"]),
      title: z.string().min(1).max(200),
      prompt: z.string().min(1).describe("What the receiving agent should do."),
      repo: z.string().optional().describe("GitHub repo as owner/name, e.g. Quillhash/usepulse-fe"),
      branch: z.string().optional().describe("Branch to work on (pushed to the remote)."),
      context: z.string().optional().describe("Progress so far, findings, files touched, decisions, open questions."),
      devin_session_id: z.string().optional().describe("Devin only: your session id (devin-...), so the hub messages you the result."),
    },
  }, async (args) => {
    const h = await hub.create(caller, args);
    return json({ ...summary(h), next: h.to_agent === "devin" ? "Poll handoff_get for Devin's progress and result." : "Queued for the local runner; poll handoff_get." });
  });

  server.registerTool("handoff_list", {
    title: "List handoffs",
    description: "List handoffs. inbox=true shows the ones waiting for you (sent to you and not finished).",
    inputSchema: {
      inbox: z.boolean().optional(),
      to: z.enum(AGENTS).optional(),
      from: z.string().optional(),
      status: z.array(z.enum(STATUSES)).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  }, async (args) => {
    const filter = args.inbox
      ? { to: caller, status: ["queued", "claimed", "in_progress"], limit: args.limit }
      : { to: args.to, from: args.from, status: args.status, limit: args.limit };
    return json((await hub.list(filter)).map(summary));
  });

  server.registerTool("handoff_get", {
    title: "Get a handoff",
    description: "Full handoff with its thread. For a Devin handoff it also pulls Devin's latest status, last message (the result) and PR.",
    inputSchema: { id: z.string() },
  }, async ({ id }) => {
    const h = await hub.get(id);
    return h ? json(h) : fail(`No handoff ${id}`);
  });

  server.registerTool("handoff_claim", {
    title: "Claim a handoff",
    description: "Take a queued handoff to work on it yourself in this session (instead of the background runner).",
    inputSchema: { id: z.string() },
  }, async ({ id }) => {
    const h = await hub.claim(id, caller);
    return h ? json(await hub.get(id)) : fail(`Handoff ${id} is not queued (already claimed or finished).`);
  });

  server.registerTool("handoff_complete", {
    title: "Complete a handoff",
    description: "Report the result of a handoff you worked on. The sender gets it (a Devin sender is messaged in its session).",
    inputSchema: {
      id: z.string(),
      result: z.string().min(1).describe("Summary of what you did, what is left, and how to verify."),
      status: z.enum(["done", "failed"]).optional(),
      pr_url: z.string().optional(),
    },
  }, async ({ id, ...rest }) => {
    const h = await hub.complete(id, caller, rest);
    return h ? json(summary(h)) : fail(`No handoff ${id}`);
  });

  server.registerTool("handoff_reply", {
    title: "Reply on a handoff",
    description: "Add a follow-up message. Sent to Devin's session for Devin handoffs; a finished local handoff is queued again so Claude/Codex resumes it.",
    inputSchema: { id: z.string(), message: z.string().min(1) },
  }, async ({ id, message }) => {
    const h = await hub.reply(id, caller, message);
    return h ? json(summary(h)) : fail(`No handoff ${id}`);
  });

  server.registerTool("handoff_cancel", {
    title: "Cancel a handoff",
    description: "Cancel a handoff that is no longer needed.",
    inputSchema: { id: z.string() },
  }, async ({ id }) => {
    const h = await hub.cancel(id, caller);
    return h ? json(summary(h)) : fail(`No handoff ${id}`);
  });

  server.registerTool("agents_status", {
    title: "Who is available",
    description: "Whether the owner's local machine (Claude/Codex runner) is online and has usage left, and whether Devin is configured.",
    inputSchema: {},
  }, async () => json(await hub.status()));

  return server;
}

export async function main() {
  const port = Number(process.env.PORT ?? 8787);
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is required");
  const tokens = parseTokens(process.env.AGENT_TOKENS);
  if (!tokens.size) throw new Error("AGENT_TOKENS is required, e.g. claude=<t1>,devin=<t2>,runner=<t3>");
  const devin = process.env.DEVIN_API_KEY && process.env.DEVIN_ORG_ID
    ? new DevinClient(process.env.DEVIN_API_KEY, process.env.DEVIN_ORG_ID)
    : null;
  const store = await Store.connect(dbUrl);
  const hub = new Hub(store, devin, process.env.PUBLIC_URL ?? `http://localhost:${port}`);

  const app = express();
  app.use(express.json({ limit: "2mb" }));

  const identify = (req: Request): string | undefined => {
    const header = req.header("authorization")?.replace(/^Bearer\s+/i, "");
    const token = header || (req.params as Record<string, string>).token || (req.query.token as string | undefined);
    return token ? tokens.get(token) : undefined;
  };
  const auth = (roles?: string[]) => (req: Request, res: Response, next: NextFunction) => {
    const who = identify(req);
    if (!who || (roles && !roles.includes(who))) return void res.status(401).json({ error: "unauthorized" });
    res.locals.who = who;
    next();
  };
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) =>
    fn(req, res).catch((e) => res.status(500).json({ error: (e as Error).message }));

  app.get("/healthz", (_req, res) => void res.json({ ok: true }));

  const mcpHandler = wrap(async (req, res) => {
    const caller = res.locals.who === "runner" ? "claude" : res.locals.who;
    const server = buildMcp(hub, caller);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const noSession = (_req: Request, res: Response) =>
    void res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
  app.post("/mcp", auth(), mcpHandler);
  app.post("/mcp/:token", auth(), mcpHandler);
  app.get(["/mcp", "/mcp/:token"], noSession);
  app.delete(["/mcp", "/mcp/:token"], noSession);

  // REST API used by the local runner.
  const runner = auth(["runner"]);
  app.post("/api/runner/heartbeat", runner, wrap(async (req, res) => {
    await hub.heartbeat(req.body.id, req.body.agents ?? ["claude"], req.body.limited_until ?? null);
    res.json({ ok: true });
  }));
  app.post("/api/runner/claim", runner, wrap(async (req, res) => {
    res.json({ handoff: await hub.claimNext(req.body.agents ?? ["claude"], req.body.id ?? "runner") });
  }));
  app.post("/api/handoffs/:id/progress", runner, wrap(async (req, res) => {
    res.json(await hub.progress(String(req.params.id), req.body, req.body.agent ?? "claude"));
  }));
  app.post("/api/handoffs/:id/complete", runner, wrap(async (req, res) => {
    res.json(await hub.complete(String(req.params.id), req.body.agent ?? "claude", req.body));
  }));
  app.post("/api/handoffs/:id/release", runner, wrap(async (req, res) => {
    res.json(await hub.release(String(req.params.id), req.body.agent ?? "claude", req.body));
  }));
  app.get("/api/handoffs/:id", auth(), wrap(async (req, res) => {
    const h = await hub.get(String(req.params.id));
    if (!h) return void res.status(404).json({ error: "not found" });
    res.json(h);
  }));
  app.get("/api/status", auth(), wrap(async (_req, res) => void res.json(await hub.status())));

  app.listen(port, () => console.log(`agent-handoff hub listening on :${port} (devin ${devin ? "on" : "off"})`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
