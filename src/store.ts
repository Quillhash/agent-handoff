import pg from "pg";
import { randomUUID } from "node:crypto";

export type Agent = "claude" | "devin" | "codex";
export type Target = Agent | "auto";
export type Status = "queued" | "claimed" | "in_progress" | "done" | "failed" | "cancelled";

export interface Handoff {
  id: string;
  from_agent: string;
  to_agent: Agent;
  title: string;
  prompt: string;
  repo: string | null;
  branch: string | null;
  context: string | null;
  status: Status;
  result: string | null;
  pr_url: string | null;
  origin_devin_session: string | null;
  devin_session_id: string | null;
  devin_session_url: string | null;
  agent_session_id: string | null;
  claimed_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: number;
  handoff_id: string;
  author: string;
  body: string;
  created_at: string;
}

export interface Runner {
  id: string;
  agents: string[];
  limited_until: string | null;
  last_seen: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  repo TEXT,
  branch TEXT,
  context TEXT,
  status TEXT NOT NULL,
  result TEXT,
  pr_url TEXT,
  origin_devin_session TEXT,
  devin_session_id TEXT,
  devin_session_url TEXT,
  agent_session_id TEXT,
  claimed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS handoffs_queue ON handoffs (to_agent, status, created_at);
CREATE TABLE IF NOT EXISTS handoff_messages (
  id SERIAL PRIMARY KEY,
  handoff_id TEXT NOT NULL REFERENCES handoffs(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS runners (
  id TEXT PRIMARY KEY,
  agents TEXT[] NOT NULL,
  limited_until TIMESTAMPTZ,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const UPDATABLE = [
  "status", "result", "pr_url", "devin_session_id", "devin_session_url",
  "agent_session_id", "claimed_by", "to_agent",
] as const;
type Updatable = Partial<Pick<Handoff, (typeof UPDATABLE)[number]>>;

export class Store {
  constructor(private pool: pg.Pool) {}

  static async connect(url: string): Promise<Store> {
    const ssl = /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined;
    const pool = new pg.Pool({ connectionString: url, ssl });
    await pool.query(SCHEMA);
    return new Store(pool);
  }

  async create(h: Omit<Handoff, "id" | "created_at" | "updated_at" | "result" | "pr_url" | "devin_session_id" | "devin_session_url" | "agent_session_id" | "claimed_by">): Promise<Handoff> {
    const id = "h_" + randomUUID().replace(/-/g, "").slice(0, 12);
    const { rows } = await this.pool.query<Handoff>(
      `INSERT INTO handoffs (id, from_agent, to_agent, title, prompt, repo, branch, context, status, origin_devin_session)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [id, h.from_agent, h.to_agent, h.title, h.prompt, h.repo, h.branch, h.context, h.status, h.origin_devin_session],
    );
    return rows[0];
  }

  async get(id: string): Promise<Handoff | null> {
    const { rows } = await this.pool.query<Handoff>("SELECT * FROM handoffs WHERE id = $1", [id]);
    return rows[0] ?? null;
  }

  async update(id: string, fields: Updatable): Promise<Handoff | null> {
    const keys = Object.keys(fields).filter((k) => (UPDATABLE as readonly string[]).includes(k));
    if (!keys.length) return this.get(id);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    const { rows } = await this.pool.query<Handoff>(
      `UPDATE handoffs SET ${sets}, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, ...keys.map((k) => (fields as Record<string, unknown>)[k])],
    );
    return rows[0] ?? null;
  }

  async list(filter: { to?: string; from?: string; status?: string[]; limit?: number }): Promise<Handoff[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.to) { args.push(filter.to); where.push(`to_agent = $${args.length}`); }
    if (filter.from) { args.push(filter.from); where.push(`from_agent = $${args.length}`); }
    if (filter.status?.length) { args.push(filter.status); where.push(`status = ANY($${args.length})`); }
    args.push(filter.limit ?? 20);
    const { rows } = await this.pool.query<Handoff>(
      `SELECT * FROM handoffs ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY updated_at DESC LIMIT $${args.length}`,
      args,
    );
    return rows;
  }

  /** Atomically claim the oldest queued handoff for one of the given agents. */
  async claimNext(agents: string[], claimer: string): Promise<Handoff | null> {
    const { rows } = await this.pool.query<Handoff>(
      `UPDATE handoffs SET status = 'claimed', claimed_by = $2, updated_at = now()
       WHERE id = (
         SELECT id FROM handoffs WHERE status = 'queued' AND to_agent = ANY($1)
         ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
       ) RETURNING *`,
      [agents, claimer],
    );
    return rows[0] ?? null;
  }

  async claim(id: string, claimer: string): Promise<Handoff | null> {
    const { rows } = await this.pool.query<Handoff>(
      `UPDATE handoffs SET status = 'claimed', claimed_by = $2, updated_at = now()
       WHERE id = $1 AND status = 'queued' RETURNING *`,
      [id, claimer],
    );
    return rows[0] ?? null;
  }

  async addMessage(handoffId: string, author: string, body: string): Promise<Message> {
    const { rows } = await this.pool.query<Message>(
      "INSERT INTO handoff_messages (handoff_id, author, body) VALUES ($1,$2,$3) RETURNING *",
      [handoffId, author, body],
    );
    await this.pool.query("UPDATE handoffs SET updated_at = now() WHERE id = $1", [handoffId]);
    return rows[0];
  }

  async messages(handoffId: string): Promise<Message[]> {
    const { rows } = await this.pool.query<Message>(
      "SELECT * FROM handoff_messages WHERE handoff_id = $1 ORDER BY id", [handoffId],
    );
    return rows;
  }

  async heartbeat(id: string, agents: string[], limitedUntil: string | null): Promise<void> {
    await this.pool.query(
      `INSERT INTO runners (id, agents, limited_until, last_seen) VALUES ($1,$2,$3,now())
       ON CONFLICT (id) DO UPDATE SET agents = $2, limited_until = $3, last_seen = now()`,
      [id, agents, limitedUntil],
    );
  }

  async runners(): Promise<Runner[]> {
    const { rows } = await this.pool.query<Runner>("SELECT * FROM runners ORDER BY last_seen DESC");
    return rows;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
