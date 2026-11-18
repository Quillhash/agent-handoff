#!/usr/bin/env node
/**
 * Local handoff runner: runs on the owner's machine, picks up handoffs sent to Claude (or Codex)
 * while the machine is online, and runs them headless. On a usage limit it hands the work to Devin.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

interface Handoff {
  id: string; from_agent: string; to_agent: string; title: string; prompt: string;
  repo: string | null; branch: string | null; context: string | null; status: string;
  agent_session_id: string | null; result: string | null;
  messages?: { author: string; body: string }[];
}

const ENV_FILE = process.env.HANDOFF_ENV_FILE ?? path.join(os.homedir(), ".config", "agent-handoff", "runner.env");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE); // written by `npm run setup`; real env vars win

const env = process.env;
const HUB_URL = (env.HANDOFF_HUB_URL ?? "").replace(/\/$/, "");
const TOKEN = env.HANDOFF_RUNNER_TOKEN ?? "";
const RUNNER_ID = env.HANDOFF_RUNNER_ID ?? os.hostname();
const AGENTS = (env.HANDOFF_AGENTS ?? "claude").split(",").map((s) => s.trim()).filter(Boolean);
const WORKSPACE = env.HANDOFF_WORKSPACE ?? path.join(os.homedir(), "agent-handoff-workspace");
const POLL_MS = Number(env.HANDOFF_POLL_SECONDS ?? 15) * 1000;
const LIMIT_COOLDOWN_MS = Number(env.HANDOFF_LIMIT_COOLDOWN_MINUTES ?? 60) * 60_000;
const FALLBACK = env.HANDOFF_ON_LIMIT ?? "devin"; // devin | requeue
const TIMEOUT_MS = Number(env.HANDOFF_TIMEOUT_MINUTES ?? 60) * 60_000;
const CLAUDE_BIN = env.HANDOFF_CLAUDE_BIN ?? "claude";
const CODEX_BIN = env.HANDOFF_CODEX_BIN ?? "codex";
// Headless runs have nobody to approve tool calls, so by default Claude may run any command (git, gh, tests).
const CLAUDE_ARGS = (env.HANDOFF_CLAUDE_ARGS ?? "--permission-mode bypassPermissions").split(" ").filter(Boolean);
const CODEX_ARGS = (env.HANDOFF_CODEX_ARGS ?? "--sandbox danger-full-access").split(" ").filter(Boolean);
const REPO_MAP: Record<string, string> = env.HANDOFF_REPO_MAP && existsSync(env.HANDOFF_REPO_MAP)
  ? JSON.parse(readFileSync(env.HANDOFF_REPO_MAP, "utf8"))
  : JSON.parse(env.HANDOFF_REPOS ?? "{}");
const ONCE = process.argv.includes("--once");

const LIMIT_RE = /usage limit|limit reached|rate.?limit|quota|credit balance|out of credits|too many requests|429/i;
const PR_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

let limitedUntil: number | null = null;

async function api<T>(method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(`${HUB_URL}${p}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

function run(cmd: string, args: string[], cwd: string, timeoutMs = TIMEOUT_MS): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: stderr + String(e) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}

interface Workdir { dir: string; note: string; branch?: string; baseSha?: string }

const git = (dir: string, ...args: string[]) => run("git", args, dir, 5 * 60_000);

async function defaultBase(clone: string): Promise<string> {
  for (let i = 0; i < 2; i++) {
    const r = await git(clone, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
    if (r.code === 0) return r.stdout.trim();
    await git(clone, "remote", "set-head", "origin", "--auto");
  }
  return "HEAD";
}

/**
 * Each repo handoff gets its own git worktree and branch (the handoff's branch, or handoff/<id>), so the
 * owner's checkout is never touched and the task can commit and push freely. Follow-ups reuse the worktree.
 */
async function prepareWorkdir(h: Handoff): Promise<Workdir> {
  mkdirSync(WORKSPACE, { recursive: true });
  if (!h.repo) return { dir: REPO_MAP["*"] ?? WORKSPACE, note: "" };
  const slug = h.repo.replace("/", "__");
  const clone = REPO_MAP[h.repo] ?? path.join(WORKSPACE, slug);
  if (!existsSync(clone)) {
    const r = await run("git", ["clone", `https://github.com/${h.repo}.git`, clone], WORKSPACE, 10 * 60_000);
    if (r.code !== 0) throw new Error(`git clone ${h.repo} failed: ${r.stderr.slice(0, 300)}`);
  }
  const dir = path.join(WORKSPACE, "worktrees", `${slug}__${h.id}`);
  if (existsSync(dir)) {
    const branch = (await git(dir, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
    return { dir, note: "", branch, baseSha: (await git(dir, "rev-parse", "HEAD")).stdout.trim() };
  }
  const fetched = await git(clone, "fetch", "origin");
  if (fetched.code !== 0) throw new Error(`git fetch in ${clone} failed: ${fetched.stderr.slice(0, 300)}`);
  let branch = h.branch ?? `handoff/${h.id}`;
  const onRemote = (await git(clone, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`)).code === 0;
  const base = onRemote ? `origin/${branch}` : await defaultBase(clone);
  let r = await git(clone, "worktree", "add", "-B", branch, dir, base);
  if (r.code !== 0 && h.branch) {
    branch = `handoff/${h.id}`; // e.g. the branch is checked out in the owner's own clone
    r = await git(clone, "worktree", "add", "-B", branch, dir, base);
  }
  if (r.code !== 0) throw new Error(`git worktree add in ${clone} failed: ${r.stderr.slice(0, 300)}`);
  const baseSha = (await git(dir, "rev-parse", "HEAD")).stdout.trim();
  const note = [
    `Your working directory is a dedicated git worktree (${dir}) on branch ${branch}, created from ${base}.`,
    `Commit your changes there, push with \`git push -u origin ${branch}\`, and open a PR (e.g. \`gh pr create --fill\`) unless the task says otherwise.`,
  ].join(" ");
  return { dir, note, branch, baseSha };
}

/** Problems that mean the task did not really finish, even if the agent exited cleanly. */
async function unfinishedWork(w: Workdir): Promise<string[]> {
  if (!w.branch) return [];
  const problems: string[] = [];
  const dirty = (await git(w.dir, "status", "--porcelain")).stdout.trim();
  if (dirty) problems.push(`uncommitted changes were left in ${w.dir}`);
  const head = (await git(w.dir, "rev-parse", "HEAD")).stdout.trim();
  if (head && head !== w.baseSha) {
    const remote = (await git(w.dir, "ls-remote", "origin", `refs/heads/${w.branch}`)).stdout.split(/\s/)[0];
    if (remote !== head) problems.push(`commits on ${w.branch} were not pushed`);
  }
  return problems;
}

function buildPrompt(h: Handoff, note: string, resuming: boolean): string {
  const followUps = (h.messages ?? []).filter((m) => m.author !== "hub" && m.author !== h.to_agent && !m.body.startsWith("Released:"));
  if (resuming && followUps.length) {
    return `Follow-up on handoff ${h.id} from ${followUps.at(-1)!.author}:\n\n${followUps.at(-1)!.body}`;
  }
  return [
    `You received handoff ${h.id} from ${h.from_agent} via the agent handoff hub.`,
    `## Task: ${h.title}`,
    h.prompt,
    h.repo ? `Repository: ${h.repo}${h.branch ? `, branch ${h.branch}` : ""} (your working directory).` : "",
    note,
    h.context ? `## Context from ${h.from_agent}\n${h.context}` : "",
    ...followUps.map((m) => `## Follow-up from ${m.author}\n${m.body}`),
    `Work autonomously: nobody can approve anything for you. Commit and push your changes (open a PR if it fits). Finish with a short summary of what you did, what is left, and any PR URL: it is sent back to ${h.from_agent}.`,
  ].filter(Boolean).join("\n\n");
}

async function runClaude(h: Handoff, dir: string, prompt: string) {
  const args = ["-p", prompt, "--output-format", "json", ...CLAUDE_ARGS];
  if (h.agent_session_id) args.push("--resume", h.agent_session_id);
  const r = await run(CLAUDE_BIN, args, dir);
  let parsed: { result?: string; session_id?: string; is_error?: boolean; permission_denials?: { tool_name: string; tool_input?: Record<string, unknown> }[] } = {};
  try { parsed = JSON.parse(r.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "{}"); } catch { /* not JSON */ }
  const text = parsed.result ?? (r.stdout || r.stderr).trim();
  const denials = (parsed.permission_denials ?? []).map((d) => {
    const input = d.tool_input?.command ?? d.tool_input?.file_path ?? "";
    return `${d.tool_name}${input ? `: ${String(input).slice(0, 80)}` : ""}`;
  });
  return { ok: r.code === 0 && !parsed.is_error, text, sessionId: parsed.session_id, raw: `${r.stdout}\n${r.stderr}`, denials };
}

async function runCodex(_h: Handoff, dir: string, prompt: string) {
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), "handoff-")), "last.txt");
  const r = await run(CODEX_BIN, ["exec", "--skip-git-repo-check", ...CODEX_ARGS, "--output-last-message", out, prompt], dir);
  const text = existsSync(out) ? readFileSync(out, "utf8").trim() : (r.stdout || r.stderr).trim();
  return { ok: r.code === 0, text, sessionId: undefined as string | undefined, raw: `${r.stdout}\n${r.stderr}`, denials: [] as string[] };
}

async function handle(h: Handoff) {
  log(`claimed ${h.id} -> ${h.to_agent}: ${h.title}`);
  const agent = h.to_agent;
  let w: Workdir;
  try {
    w = await prepareWorkdir(h);
  } catch (e) {
    await api("POST", `/api/handoffs/${h.id}/complete`, { agent, status: "failed", result: `Runner could not prepare the repo: ${(e as Error).message}` });
    return;
  }
  await api("POST", `/api/handoffs/${h.id}/progress`, { agent, note: `${agent} started on ${RUNNER_ID} in ${w.dir}${w.branch ? ` (branch ${w.branch})` : ""}` });
  const prompt = buildPrompt(h, w.note, Boolean(h.agent_session_id));
  const r = agent === "codex" ? await runCodex(h, w.dir, prompt) : await runClaude(h, w.dir, prompt);

  if (!r.ok && LIMIT_RE.test(r.raw)) {
    limitedUntil = Date.now() + LIMIT_COOLDOWN_MS;
    log(`${agent} hit a usage limit; ${FALLBACK === "devin" ? "handing off to Devin" : "requeueing"}`);
    await api("POST", `/api/handoffs/${h.id}/release`, {
      agent,
      reason: `${agent} usage limit reached on ${RUNNER_ID}: ${r.text.slice(0, 300)}`,
      ...(FALLBACK === "devin" ? { reroute_to: "devin" } : {}),
    });
    await heartbeat();
    return;
  }
  const problems = [
    ...(r.denials.length ? [`${r.denials.length} tool call(s) needed an approval nobody could give (${r.denials.slice(0, 5).join("; ")})`] : []),
    ...(await unfinishedWork(w)),
  ];
  const ok = r.ok && problems.length === 0;
  const text = r.text || "(no output)";
  await api("POST", `/api/handoffs/${h.id}/complete`, {
    agent,
    status: ok ? "done" : "failed",
    result: problems.length ? `Blocked on ${RUNNER_ID}: ${problems.join("; ")}.\n\n${text}` : text,
    pr_url: r.text.match(PR_RE)?.[0],
    agent_session_id: r.sessionId,
  });
  log(`${h.id} ${ok ? "done" : "failed"}${problems.length ? `: ${problems.join("; ")}` : ""}`);
}

async function heartbeat() {
  if (limitedUntil && limitedUntil < Date.now()) limitedUntil = null;
  await api("POST", "/api/runner/heartbeat", {
    id: RUNNER_ID, agents: AGENTS, limited_until: limitedUntil ? new Date(limitedUntil).toISOString() : null,
  });
}

async function tick(): Promise<boolean> {
  await heartbeat();
  if (limitedUntil) return false;
  const { handoff } = await api<{ handoff: Handoff | null }>("POST", "/api/runner/claim", { id: RUNNER_ID, agents: AGENTS });
  if (!handoff) return false;
  await handle(handoff);
  return true;
}

async function main() {
  if (!HUB_URL || !TOKEN) {
    console.error("Set HANDOFF_HUB_URL and HANDOFF_RUNNER_TOKEN (see README).");
    process.exit(1);
  }
  log(`runner ${RUNNER_ID} polling ${HUB_URL} for ${AGENTS.join(",")} every ${POLL_MS / 1000}s`);
  for (;;) {
    let worked = false;
    try { worked = await tick(); } catch (e) { log("error:", (e as Error).message); }
    if (ONCE) return;
    if (!worked) await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main();
