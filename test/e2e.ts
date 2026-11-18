/**
 * End-to-end test: real hub + Postgres, mock Devin API, real runner with a fake `claude` binary.
 * Needs TEST_DATABASE_URL (a throwaway database).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMockDevin } from "./mock-devin.js";

const root = path.resolve(import.meta.dirname, "..");
const DB = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5433/handoff";
const HUB_PORT = 18787, DEVIN_PORT = 18788;
const HUB = `http://localhost:${HUB_PORT}`;
const T = { claude: "tok-claude", devin: "tok-devin", runner: "tok-runner" };
const tmp = mkdtempSync(path.join(os.tmpdir(), "handoff-e2e-"));
const fakeLog = path.join(tmp, "fake-claude.log");
const procs: ChildProcess[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mcp(token: string) {
  const c = new Client({ name: "e2e", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${HUB}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await c.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
    return JSON.parse(r.content[0].text);
  };
}

// Async on purpose: the mock Devin API lives in this process and must keep serving while the runner works.
function runner(extraEnv: Record<string, string> = {}): Promise<void> {
  const child = spawn("node", ["--import", "tsx", "src/runner.ts", "--once"], {
    cwd: root, stdio: "inherit",
    env: { ...process.env, HANDOFF_HUB_URL: HUB, HANDOFF_RUNNER_TOKEN: T.runner, HANDOFF_RUNNER_ID: "test-laptop",
      HANDOFF_CLAUDE_BIN: path.join(root, "test/fake-claude.sh"), HANDOFF_WORKSPACE: tmp, FAKE_CLAUDE_LOG: fakeLog, ...extraEnv },
  });
  return new Promise((resolve, reject) => child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`runner exited ${code}`)))));
}

async function main() {
  const db = new pg.Client({ connectionString: DB });
  await db.connect();
  await db.query("DROP TABLE IF EXISTS handoff_messages, handoffs, runners");
  const devin = startMockDevin(DEVIN_PORT);
  const hub = spawn("node", ["--import", "tsx", "src/server.ts"], {
    cwd: root, stdio: "inherit",
    env: { ...process.env, PORT: String(HUB_PORT), DATABASE_URL: DB, AGENT_TOKENS: `claude=${T.claude},devin=${T.devin},runner=${T.runner}`,
      DEVIN_API_KEY: "test", DEVIN_ORG_ID: "org-test", DEVIN_API_BASE: `http://localhost:${DEVIN_PORT}` },
  });
  procs.push(hub);
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${HUB}/healthz`)).ok) break; } catch {} await sleep(200); }

  const claude = await mcp(T.claude);
  const devinMcp = await mcp(T.devin);

  // Auth
  assert.equal((await fetch(`${HUB}/mcp`, { method: "POST", headers: { Authorization: "Bearer nope" } })).status, 401);

  // 1. Claude -> Devin
  const a = await claude("handoff_create", { to: "devin", title: "Fix login bug", prompt: "Login 500s on empty email", repo: "Quillhash/demo", branch: "fix/login", context: "Repro: POST /login {}" });
  assert.equal(a.to, "devin"); assert.equal(a.status, "in_progress"); assert.ok(a.devin_session_url);
  const sess = [...devin.sessions.values()][0];
  assert.match(sess.prompt, /Login 500s on empty email/); assert.match(sess.prompt, /Repro: POST \/login/); assert.match(sess.prompt, /fix\/login/);
  await claude("handoff_reply", { id: a.id, message: "Also add a test" });
  assert.match(devin.sent.at(-1)!.message, /Also add a test/);
  devin.finish("devin-mock1", "Fixed and added a test. PR https://github.com/Quillhash/demo/pull/9");
  const aDone = await claude("handoff_get", { id: a.id });
  assert.equal(aDone.status, "done"); assert.match(aDone.result, /added a test/); assert.equal(aDone.pr_url, "https://github.com/Quillhash/demo/pull/9");
  console.log("ok 1 claude -> devin: session started, follow-up forwarded, result + PR synced back");

  // 2. Devin -> Claude (runner)
  const b = await devinMcp("handoff_create", { to: "claude", title: "Run local e2e", prompt: "Run the suite on the laptop", devin_session_id: "abc123" });
  assert.equal(b.status, "queued");
  const inbox = await claude("handoff_list", { inbox: true });
  assert.ok(inbox.some((h: { id: string }) => h.id === b.id));
  await runner();
  const bDone = await devinMcp("handoff_get", { id: b.id });
  assert.equal(bDone.status, "done"); assert.match(bDone.result, /Fixed it/); assert.equal(bDone.pr_url, "https://github.com/Quillhash/demo/pull/7"); assert.ok(bDone.agent_session_id);
  const note = devin.sent.find((m) => m.session === "devin-abc123");
  assert.ok(note, "origin Devin session was messaged"); assert.match(note!.message, /done by claude/); assert.match(note!.message, /pull\/7/);
  console.log("ok 2 devin -> claude: runner ran claude, result sent back to the Devin session");

  // 3. Follow-up resumes the same Claude session
  await devinMcp("handoff_reply", { id: b.id, message: "Please also update the README" });
  assert.equal((await devinMcp("handoff_get", { id: b.id })).status, "queued");
  await runner();
  assert.match(readFileSync(fakeLog, "utf8").trim().split("\n").at(-1)!, new RegExp(`resume=${bDone.agent_session_id} prompt=Follow-up`));
  assert.match((await devinMcp("handoff_get", { id: b.id })).result, /Resumed/);
  console.log("ok 3 follow-up requeued and resumed the same claude session");

  // 4. Interactive Claude claims and completes by hand
  const c = await devinMcp("handoff_create", { to: "claude", title: "Review", prompt: "Review PR 9", devin_session_id: "devin-abc123" });
  const claimed = await claude("handoff_claim", { id: c.id });
  assert.equal(claimed.status, "claimed");
  await claude("handoff_complete", { id: c.id, result: "LGTM" });
  assert.match(devin.sent.at(-1)!.message, /LGTM/);
  console.log("ok 4 interactive claude claim + complete notifies Devin");

  // 5. auto routing follows runner availability
  let s = await claude("agents_status");
  assert.equal(s.claude_available, true);
  assert.equal((await devinMcp("handoff_create", { to: "auto", title: "auto1", prompt: "x" })).to, "claude");
  await claude("handoff_cancel", { id: (await claude("handoff_list", { inbox: true }))[0].id });

  // 6. Usage limit: runner hands the task to Devin and marks itself limited
  const d = await devinMcp("handoff_create", { to: "claude", title: "Big refactor", prompt: "SIMULATE_LIMIT refactor auth" });
  await runner();
  const dAfter = await devinMcp("handoff_get", { id: d.id });
  assert.equal(dAfter.to_agent, "devin"); assert.equal(dAfter.status, "in_progress"); assert.ok(dAfter.devin_session_id);
  assert.match([...devin.sessions.values()].at(-1)!.prompt, /usage limit/);
  s = await claude("agents_status");
  assert.equal(s.claude_available, false); assert.ok(s.runners[0].usage_limited_until);
  assert.equal((await devinMcp("handoff_create", { to: "auto", title: "auto2", prompt: "x" })).to, "devin");
  console.log("ok 5 usage limit reroutes to Devin; auto picks claude when online, devin when limited");

  await db.end();
  console.log("all e2e checks passed");
}

main().then(() => { procs.forEach((p) => p.kill()); process.exit(0); }, (e) => { console.error(e); procs.forEach((p) => p.kill()); process.exit(1); });
