#!/usr/bin/env node
// One-time local setup: reads the hub tokens from Railway and installs them for Claude Code and the runner,
// without printing them. Needs Railway access to the QuillAudits Services project: either the `railway` CLI
// signed in (`railway login`), or RAILWAY_API_TOKEN set to an account/workspace token.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PROJECT = "0c5d3cbe-9be1-4f87-8241-0382f71951e1";
const ENVIRONMENT = "57bf8236-c4d3-4d5c-aa7b-df85214be1d0"; // production
const SERVICE = "20fbc003-1e53-4c6c-8c0c-1581fae8d230"; // agent-handoff-hub
const HUB_URL = process.env.HANDOFF_HUB_URL ?? "https://agent-handoff-hub-production.up.railway.app";
const ENV_FILE = process.env.HANDOFF_ENV_FILE ?? path.join(os.homedir(), ".config", "agent-handoff", "runner.env");
const skipClaude = process.argv.includes("--runner-only");
const skipRunner = process.argv.includes("--claude-only");

async function readVariables() {
  const token = process.env.RAILWAY_API_TOKEN;
  if (token) {
    const res = await fetch("https://backboard.railway.com/graphql/v2", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "query($p:String!,$e:String!,$s:String!){ variables(projectId:$p, environmentId:$e, serviceId:$s) }",
        variables: { p: PROJECT, e: ENVIRONMENT, s: SERVICE },
      }),
    });
    const body = await res.json();
    if (body.errors) throw new Error(`Railway API: ${body.errors[0].message}`);
    return body.data.variables;
  }
  const run = (args) => execFileSync("railway", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    return JSON.parse(run(["variables", "--service", SERVICE, "--environment", ENVIRONMENT, "--json"]));
  } catch {
    const dir = path.join(os.tmpdir(), "agent-handoff-railway");
    mkdirSync(dir, { recursive: true });
    execFileSync("railway", ["link", "--project", PROJECT, "--environment", ENVIRONMENT, "--service", SERVICE], { cwd: dir, stdio: ["ignore", "ignore", "inherit"] });
    return JSON.parse(execFileSync("railway", ["variables", "--service", SERVICE, "--environment", ENVIRONMENT, "--json"], { cwd: dir, encoding: "utf8" }));
  }
}

const vars = await readVariables().catch((e) => {
  console.error(`Could not read the hub's variables from Railway (${e.message}).\nSign in with \`railway login\` (an account with access to QuillAudits Services) or set RAILWAY_API_TOKEN, then rerun.`);
  process.exit(1);
});
const tokens = Object.fromEntries(
  String(vars.AGENT_TOKENS ?? "").split(",").map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf("=");
    return [p.slice(0, i), p.slice(i + 1)];
  }),
);
if (!tokens.claude || !tokens.runner) {
  console.error("AGENT_TOKENS on agent-handoff-hub has no claude/runner entry.");
  process.exit(1);
}

if (!skipClaude) {
  try { execFileSync("claude", ["mcp", "remove", "agent-handoff", "--scope", "user"], { stdio: "ignore" }); } catch { /* not installed yet */ }
  execFileSync("claude", ["mcp", "add", "--transport", "http", "--scope", "user", "agent-handoff", `${HUB_URL}/mcp`,
    "--header", `Authorization: Bearer ${tokens.claude}`], { stdio: ["ignore", "ignore", "inherit"] });
  console.log("Claude Code: added MCP server \"agent-handoff\" (user scope).");
}

if (!skipRunner) {
  mkdirSync(path.dirname(ENV_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(ENV_FILE, `HANDOFF_HUB_URL=${HUB_URL}\nHANDOFF_RUNNER_TOKEN=${tokens.runner}\n`, { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
  console.log(`Runner: wrote ${ENV_FILE} (mode 600). Start it with \`npm run runner\`.`);
}
