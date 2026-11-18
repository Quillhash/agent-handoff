const API = process.env.DEVIN_API_BASE ?? "https://api.devin.ai";

export interface DevinSession {
  session_id: string;
  url: string;
  status: string;
  status_detail?: string | null;
  title?: string | null;
  pull_requests?: { pr_url: string; pr_state: string | null }[];
}

export interface DevinMessage {
  event_id: string;
  source: "user" | "devin" | string;
  message: string;
  created_at: number;
}

export const toDevinId = (id: string) => (id.startsWith("devin-") ? id : `devin-${id}`);

export class DevinClient {
  constructor(private apiKey: string, private orgId: string) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API}/v3/organizations/${this.orgId}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Devin API ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  createSession(prompt: string, title: string, tags: string[]): Promise<DevinSession> {
    return this.call("POST", "/sessions", { prompt, title, tags });
  }

  getSession(id: string): Promise<DevinSession> {
    return this.call("GET", `/sessions/${toDevinId(id)}`);
  }

  sendMessage(id: string, message: string): Promise<unknown> {
    return this.call("POST", `/sessions/${toDevinId(id)}/messages`, { message });
  }

  async messages(id: string): Promise<DevinMessage[]> {
    const out: DevinMessage[] = [];
    let after: string | undefined;
    for (let page = 0; page < 20; page++) {
      const q = new URLSearchParams({ first: "100", ...(after ? { after } : {}) });
      const r = await this.call<{ items: DevinMessage[]; end_cursor?: string | null; has_next_page?: boolean }>(
        "GET", `/sessions/${toDevinId(id)}/messages?${q}`,
      );
      out.push(...r.items);
      if (!r.has_next_page || !r.end_cursor) break;
      after = r.end_cursor;
    }
    return out;
  }
}
