import os from "node:os";
import { Store, type Agent, type Handoff, type Target } from "./store.js";
import { DevinClient, toDevinId } from "./devin.js";

const TERMINAL = new Set(["done", "failed", "cancelled"]);
const RUNNER_ONLINE_MS = Number(process.env.RUNNER_ONLINE_SECONDS ?? 120) * 1000;

export interface CreateInput {
  to: Target;
  title: string;
  prompt: string;
  repo?: string;
  branch?: string;
  context?: string;
  devin_session_id?: string;
}

export class Hub {
  constructor(private store: Store, private devin: DevinClient | null, private publicUrl: string) {}

  async onlineRunners(agent: Agent) {
    const now = Date.now();
    return (await this.store.runners()).filter(
      (r) =>
        r.agents.includes(agent) &&
        now - new Date(r.last_seen).getTime() < RUNNER_ONLINE_MS &&
        (!r.limited_until || new Date(r.limited_until).getTime() < now),
    );
  }

  async status() {
    const now = Date.now();
    const runners = (await this.store.runners()).map((r) => ({
      id: r.id,
      agents: r.agents,
      online: now - new Date(r.last_seen).getTime() < RUNNER_ONLINE_MS,
      usage_limited_until: r.limited_until && new Date(r.limited_until).getTime() > now ? r.limited_until : null,
      last_seen: r.last_seen,
    }));
    return {
      devin: this.devin ? "available (Devin API configured)" : "unavailable (DEVIN_API_KEY not set)",
      claude_available: (await this.onlineRunners("claude")).length > 0,
      codex_available: (await this.onlineRunners("codex")).length > 0,
      runners,
    };
  }

  /** `auto` sends work to the local Claude when its runner is online with usage left, else to Devin. */
  async resolveTarget(to: Target, from: string): Promise<Agent> {
    if (to !== "auto") return to;
    if (from !== "claude" && (await this.onlineRunners("claude")).length) return "claude";
    return "devin";
  }

  async create(from: string, input: CreateInput): Promise<Handoff> {
    const to = await this.resolveTarget(input.to, from);
    const originDevin = from === "devin" && input.devin_session_id ? toDevinId(input.devin_session_id) : null;
    let h = await this.store.create({
      from_agent: from,
      to_agent: to,
      title: input.title,
      prompt: input.prompt,
      repo: input.repo ?? null,
      branch: input.branch ?? null,
      context: input.context ?? null,
      status: "queued",
      origin_devin_session: originDevin,
    });
    if (to === "devin") h = await this.startDevin(h);
    return h;
  }

  private devinPrompt(h: Handoff, followUps: string[] = []): string {
    return [
      `Handoff ${h.id} from ${h.from_agent} via the agent handoff hub.`,
      ``,
      `## Task: ${h.title}`,
      h.prompt,
      h.repo ? `\nRepository: ${h.repo}${h.branch ? ` (branch: ${h.branch})` : ""}` : "",
      h.context ? `\n## Context from ${h.from_agent}\n${h.context}` : "",
      ...followUps.map((m) => `\n## Follow-up\n${m}`),
      ``,
      `When you finish, end with a short summary of what you did and any PR link: the hub syncs your last message back to ${h.from_agent} as the result.`,
      `If the agent-handoff MCP is connected, you may instead call handoff_complete with id "${h.id}".`,
    ].filter((l) => l !== "").join("\n");
  }

  private async startDevin(h: Handoff, followUps: string[] = []): Promise<Handoff> {
    if (!this.devin) {
      await this.store.addMessage(h.id, "hub", "Devin API not configured on the hub (DEVIN_API_KEY).");
      return (await this.store.update(h.id, { status: "failed", result: "Devin API not configured on the hub." }))!;
    }
    try {
      const s = await this.devin.createSession(this.devinPrompt(h, followUps), h.title, ["agent-handoff", `handoff:${h.id}`]);
      return (await this.store.update(h.id, {
        to_agent: "devin",
        status: "in_progress",
        devin_session_id: toDevinId(s.session_id),
        devin_session_url: s.url,
      }))!;
    } catch (e) {
      const msg = (e as Error).message;
      await this.store.addMessage(h.id, "hub", msg);
      return (await this.store.update(h.id, { status: "failed", result: `Could not start Devin session: ${msg}` }))!;
    }
  }

  /** Pull the latest state of a Devin-backed handoff from the Devin API. */
  async refresh(h: Handoff): Promise<Handoff & { devin_status?: string; note?: string }> {
    if (h.to_agent !== "devin" || !h.devin_session_id || !this.devin || TERMINAL.has(h.status)) return h;
    try {
      const s = await this.devin.getSession(h.devin_session_id);
      const msgs = await this.devin.messages(h.devin_session_id);
      const last = [...msgs].reverse().find((m) => m.source === "devin");
      const pr = s.pull_requests?.[0]?.pr_url ?? null;
      const detail = s.status_detail ?? "";
      let status = h.status;
      if (s.status === "exit" || detail === "finished") status = "done";
      else if (s.status === "error") status = "failed";
      const updated = await this.store.update(h.id, {
        status,
        result: last?.message ?? h.result,
        pr_url: pr ?? h.pr_url,
      });
      return {
        ...updated!,
        devin_status: detail ? `${s.status} (${detail})` : s.status,
        ...(detail === "waiting_for_user" ? { note: "Devin is waiting for a reply: its last message is in result. Answer with handoff_reply, or treat result as final." } : {}),
      };
    } catch (e) {
      return { ...h, devin_status: `unknown: ${(e as Error).message}` };
    }
  }

  async get(id: string) {
    const h = await this.store.get(id);
    if (!h) return null;
    const fresh = await this.refresh(h);
    return { ...fresh, messages: await this.store.messages(id) };
  }

  async list(filter: { to?: string; from?: string; status?: string[]; limit?: number }) {
    return this.store.list(filter);
  }

  async claim(id: string, claimer: string) {
    return this.store.claim(id, claimer);
  }

  async claimNext(agents: string[], claimer: string) {
    const h = await this.store.claimNext(agents, claimer);
    return h ? { ...h, messages: await this.store.messages(h.id) } : null;
  }

  async progress(id: string, fields: { agent_session_id?: string; note?: string }, author: string) {
    if (fields.note) await this.store.addMessage(id, author, fields.note);
    return this.store.update(id, { status: "in_progress", ...(fields.agent_session_id ? { agent_session_id: fields.agent_session_id } : {}) });
  }

  async complete(
    id: string,
    author: string,
    input: { status?: "done" | "failed"; result: string; pr_url?: string; agent_session_id?: string },
  ) {
    const h = await this.store.update(id, {
      status: input.status ?? "done",
      result: input.result,
      ...(input.pr_url ? { pr_url: input.pr_url } : {}),
      ...(input.agent_session_id ? { agent_session_id: input.agent_session_id } : {}),
    });
    if (!h) return null;
    await this.store.addMessage(id, author, `[${h.status}] ${input.result}`);
    await this.notifyOrigin(h, author);
    return h;
  }

  private async notifyOrigin(h: Handoff, author: string) {
    if (!h.origin_devin_session || !this.devin) return;
    const body = [
      `Handoff ${h.id} ("${h.title}") is ${h.status} by ${author}.`,
      h.pr_url ? `PR: ${h.pr_url}` : "",
      ``,
      h.result ?? "",
      ``,
      `Reply via the agent-handoff MCP: handoff_reply id "${h.id}".`,
    ].filter((l) => l !== "").join("\n");
    try {
      await this.devin.sendMessage(h.origin_devin_session, body);
    } catch (e) {
      await this.store.addMessage(h.id, "hub", `Could not notify Devin session: ${(e as Error).message}`);
    }
  }

  /** Add a follow-up. A finished handoff to a local agent is queued again so its runner resumes it. */
  async reply(id: string, author: string, message: string) {
    const h = await this.store.get(id);
    if (!h) return null;
    await this.store.addMessage(id, author, message);
    if (h.to_agent === "devin" && author !== "devin") {
      if (h.devin_session_id && this.devin) {
        await this.devin.sendMessage(h.devin_session_id, `Follow-up on handoff ${h.id} from ${author}:\n\n${message}`);
        return this.store.update(id, { status: "in_progress" });
      }
      return h;
    }
    if (author === h.to_agent) {
      if (h.origin_devin_session && this.devin) {
        await this.devin.sendMessage(h.origin_devin_session, `${author} on handoff ${h.id} ("${h.title}"):\n\n${message}`);
      }
      return h;
    }
    if (TERMINAL.has(h.status) || h.status === "in_progress") {
      return this.store.update(id, { status: "queued", claimed_by: null });
    }
    return h;
  }

  /** A runner gives a handoff back, e.g. when its agent hit a usage limit. */
  async release(id: string, author: string, input: { reason: string; reroute_to?: Agent }) {
    const h = await this.store.get(id);
    if (!h) return null;
    await this.store.addMessage(id, author, `Released: ${input.reason}`);
    if (input.reroute_to === "devin") {
      const msgs = (await this.store.messages(id)).filter((m) => m.author !== "hub").map((m) => `${m.author}: ${m.body}`);
      return this.startDevin(h, msgs);
    }
    return this.store.update(id, {
      status: "queued",
      claimed_by: null,
      ...(input.reroute_to ? { to_agent: input.reroute_to } : {}),
    });
  }

  async cancel(id: string, author: string) {
    await this.store.addMessage(id, author, "Cancelled");
    return this.store.update(id, { status: "cancelled" });
  }

  async heartbeat(id: string, agents: string[], limitedUntil: string | null) {
    await this.store.heartbeat(id || os.hostname(), agents, limitedUntil);
  }

  get url() {
    return this.publicUrl;
  }
}
