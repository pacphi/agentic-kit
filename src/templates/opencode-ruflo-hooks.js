// ruflo-hooks.js — bridge opencode lifecycle events to ruflo's hook verbs.
// Deployed to ~/.config/opencode/plugins/ by `ak setup` / `ak sync`
// (agentic-kit, src/templates/opencode-ruflo-hooks.js — managed; do not edit
// the deployed copy, sync rewrites it).
//
// Mirrors what `ruflo init` wires into Claude Code's settings.json, but for
// opencode. All verbs run through ruflo's LOCAL hook-handler (fast paths, no
// MCP round-trip, 5s internal safety timeout, always exits 0):
//
//   session.created    → session-restore   (load intelligence/session state)
//   session.compacted  → session-restore   (reload state after compaction)
//   session.deleted    → session-end       (consolidate learning, persist)
//   bash before        → pre-bash          (block catastrophic commands)
//   edit/write after   → post-edit         (record outcome for learning)
//   task before/after  → pre-task/post-task(route subagent work, feed learning)
//   chat.message       → route             (inject routing recommendation)
//
// Failure policy: lifecycle and learning hooks never break opencode. An
// explicit [BLOCKED] pre-bash verdict or a proven repeated tool+args+output
// loop stops the active tool call; every other integration error is swallowed.

import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

const HOOK_TIMEOUT_MS = 4500
const ROUTE_MIN_PROMPT = 12
const ROUTE_MAX_INJECT = 1200
const TRIVIAL_PROMPT = /^(yes|y|ok|k|sure|continue|go ahead|proceed|lgtm|next)[.!]?$/i
const TOOL_LOOP_THRESHOLD = 3
const TOOL_LOOP_SESSION_LIMIT = 256

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
  }
  const encoded = JSON.stringify(value)
  return encoded === undefined ? String(value) : encoded
}

function trimOldest(map, limit) {
  while (map.size > limit) map.delete(map.keys().next().value)
}

// OpenCode 1.18.18's native detector only inspects parts on the current
// assistant message. Tool-driven agent turns create a new assistant message
// after every tool result, so the detector never sees a three-call streak.
// This guard keeps only the trailing completed call per session. It requires
// the tool name, canonical args, and output to repeat three times before it
// blocks the next identical call. A real user message resets the streak;
// assistant continuations and compaction do not.
function createToolLoopGuard({ threshold = TOOL_LOOP_THRESHOLD } = {}) {
  const completed = new Map()
  const pending = new Map()
  const pendingKey = (sessionID, callID) => `${sessionID}\u0000${callID}`

  return {
    before({ sessionID, callID, tool }, args) {
      const signature = `${tool}\u0000${canonicalJson(args)}`
      const prior = completed.get(sessionID)
      if (prior && prior.signature === signature && prior.count >= threshold) {
        return {
          blocked: true,
          count: prior.count,
          fingerprint: signature,
        }
      }
      // An intervening tool or argument set breaks a trailing streak even if
      // that call later fails before the after-hook can run.
      if (prior && prior.signature !== signature) completed.delete(sessionID)
      pending.set(pendingKey(sessionID, callID), { sessionID, signature })
      trimOldest(pending, TOOL_LOOP_SESSION_LIMIT * 8)
      return { blocked: false }
    },

    after({ sessionID, callID }, output) {
      const key = pendingKey(sessionID, callID)
      const call = pending.get(key)
      pending.delete(key)
      if (!call) return
      const outputFingerprint = canonicalJson(output)
      const prior = completed.get(sessionID)
      const count = prior
        && prior.signature === call.signature
        && prior.outputFingerprint === outputFingerprint
        ? prior.count + 1
        : 1
      completed.delete(sessionID)
      completed.set(sessionID, {
        signature: call.signature,
        outputFingerprint,
        count,
      })
      trimOldest(completed, TOOL_LOOP_SESSION_LIMIT)
    },

    reset(sessionID) {
      completed.delete(sessionID)
      for (const [key, call] of pending) {
        if (call.sessionID === sessionID) pending.delete(key)
      }
    },
  }
}

// The hook-handler ships with ruflo — resolve it without machine-specific
// hardcodes: explicit override → claude marketplace clone (auto-updated) →
// npm global package (direct + nested-under-ruflo layouts) → legacy /opt checkout.
function resolveHookHandler() {
  const home = os.homedir()
  const rel = path.join(".claude", "helpers", "hook-handler.cjs")
  const candidates = []
  if (process.env.RUFLO_REPO) candidates.push(path.join(process.env.RUFLO_REPO, rel))
  candidates.push(path.join(home, ".claude", "plugins", "marketplaces", "ruflo", rel))
  for (const root of [
    process.env.npm_prefix && path.join(process.env.npm_prefix, "lib", "node_modules"),
    path.join(process.execPath, "..", "..", "lib", "node_modules"),
  ]) {
    if (root) {
      candidates.push(path.join(root, "@claude-flow", "cli", rel))
      candidates.push(path.join(root, "ruflo", "node_modules", "@claude-flow", "cli", rel))
    }
  }
  candidates.push(path.join("/opt/ruflo", rel))
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c } catch { /* next */ }
  }
  return null
}

const HANDLER = resolveHookHandler()

function projectHookEnv(directory, env = process.env) {
  const resolved = path.resolve(directory)
  let root = resolved
  try { root = fs.realpathSync(resolved) } catch { /* preserve the resolved path */ }
  return {
    ...env,
    CLAUDE_FLOW_DB_PATH: path.join(root, ".swarm", "memory.db"),
  }
}

function runHook(verb, payload, directory = process.cwd()) {
  return new Promise((resolve) => {
    if (!HANDLER) return resolve({ ok: false, stdout: "", stderr: "no handler" })
    let stdout = ""
    let stderr = ""
    let settled = false
    const done = (result) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
    }
    let child
    try {
      const resolved = path.resolve(directory)
      let cwd = resolved
      try { cwd = fs.realpathSync(resolved) } catch { /* preserve the resolved path */ }
      child = spawn("node", [HANDLER, verb], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: projectHookEnv(directory),
      })
    } catch {
      return done({ ok: false, stdout: "", stderr: "spawn failed" })
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL") } catch { /* already dead */ }
      done({ ok: false, stdout, stderr: stderr + " [timeout]" })
    }, HOOK_TIMEOUT_MS)
    child.stdout.on("data", (d) => { stdout += d })
    child.stderr.on("data", (d) => { stderr += d })
    child.on("error", () => done({ ok: false, stdout, stderr }))
    child.on("close", (code) => done({ ok: code === 0, stdout, stderr, code }))
    try {
      child.stdin.write(JSON.stringify(payload ?? {}))
      child.stdin.end()
    } catch {
      done({ ok: false, stdout, stderr: "stdin failed" })
    }
  })
}

// Fire-and-forget wrapper: never throws, never blocks the event loop turn.
function fire(verb, payload, directory) {
  runHook(verb, payload, directory).catch(() => {})
}

function promptText(parts) {
  if (!Array.isArray(parts)) return ""
  return parts
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim()
}

function directOpenCodeReferences(text) {
  return String(text)
    .replace(/mcp__(?:claude-flow|claude_flow|ruflo)__([A-Za-z0-9_*-]+)/g, "claude-flow_$1")
    .replace(/mcp__(?:agentic-qe|agentic_qe)__([A-Za-z0-9_*-]+)/g, "agentic-qe_$1")
}

const plugin = async ({ client, directory = process.cwd() }) => {
  const toolLoopGuard = createToolLoopGuard()
  await client.app.log({
    body: {
      service: "ruflo-hooks",
      level: HANDLER ? "info" : "warn",
      message: HANDLER ? `ruflo lifecycle bridge loaded (${HANDLER})` : "ruflo hook-handler not found — bridge inert",
    },
  })

  return {
    event: async ({ event }) => {
      try {
        switch (event?.type) {
          case "session.created":
            fire("session-restore", undefined, directory)
            break
          case "session.compacted":
            fire("session-restore", undefined, directory)
            break
          case "session.deleted":
            toolLoopGuard.reset(event?.properties?.info?.id ?? event?.properties?.sessionID)
            fire("session-end", undefined, directory)
            break
        }
      } catch { /* never break opencode */ }
    },

    "chat.message": async (input, output) => {
      try {
        toolLoopGuard.reset(input.sessionID)
        const prompt = promptText(output?.parts)
        if (prompt.length < ROUTE_MIN_PROMPT || TRIVIAL_PROMPT.test(prompt)) return
        const res = await runHook("route", { prompt }, directory)
        const text = (res.stdout || "").trim()
        if (!res.ok || !text || text.includes("Router not available")) return
        // A part opencode can actually persist (codex review): the validator
        // requires id/messageID/sessionID on every returned part — a bare
        // {type,text} part can fail message persistence. synthetic:true marks
        // it as injected context, not user content.
        const messageID = output?.message?.id ?? input?.messageID
        output.parts.push({
          // opencode PartID schema requires the "prt" prefix (schema.ts)
          id: `prt_ruflo_route_${Date.now().toString(36)}`,
          messageID,
          sessionID: input?.sessionID ?? output?.message?.sessionID,
          type: "text",
          synthetic: true,
          text: `[ruflo routing context — ephemeral, not part of the user request]\n${text.slice(0, ROUTE_MAX_INJECT)}`,
        })
      } catch { /* routing context is best-effort */ }
    },

    "tool.execute.before": async (input, output) => {
      try {
        const loop = toolLoopGuard.before(input, output?.args)
        if (loop.blocked) {
          try {
            await client.session.abort({ path: { id: input.sessionID } })
          } catch { /* the guard error below is the fail-closed path */ }
          throw new Error(
            `[ruflo] Probable doom loop stopped after ${loop.count} identical completed calls: ${input.tool}`,
          )
        }
        if (input.tool === "bash") {
          const command = output?.args?.command
          if (typeof command !== "string" || !command) return
          const res = await runHook("pre-bash", {
            tool_name: "Bash",
            tool_input: { command },
          }, directory)
          if (!res.ok && /\[BLOCKED]/i.test(res.stderr + res.stdout)) {
            throw new Error(`[ruflo] Blocked dangerous command: ${command.slice(0, 120)}`)
          }
        } else if (input.tool === "task") {
          const description = output?.args?.description ?? output?.args?.prompt ?? ""
          fire("pre-task", { prompt: String(description).slice(0, 500) }, directory)
        }
      } catch (e) {
        if (e && e.message && e.message.startsWith("[ruflo]")) throw e
        /* anything else: allow */
      }
    },

    "tool.execute.after": async (input, output) => {
      try {
        toolLoopGuard.after(input, output?.output)
        // Skills originate in the shared Ruflo catalogue and can carry Claude
        // MCP spellings. Normalize them on the OpenCode-only surface even when
        // the optional lazy gateway is unavailable; the gateway may then
        // rewrite an owned family from this direct spelling to search/call.
        if (input.tool === "skill" && typeof output?.output === "string") {
          output.output = directOpenCodeReferences(output.output)
        }
        if (input.tool === "edit" || input.tool === "write" || input.tool === "apply_patch") {
          const filePath = input?.args?.filePath ?? input?.args?.file_path ?? ""
          fire("post-edit", {
            tool_name: input.tool,
            tool_input: { file_path: filePath },
            tool_response: typeof output?.output === "string" ? output.output.slice(0, 2000) : "",
          }, directory)
        } else if (input.tool === "task") {
          fire("post-task", {
            tool_response: typeof output?.output === "string" ? output.output.slice(0, 2000) : "",
          }, directory)
        }
      } catch { /* learning hooks are best-effort */ }
    },
  }
}

export default plugin
export { canonicalJson, createToolLoopGuard, plugin as RufloHooks, projectHookEnv }
