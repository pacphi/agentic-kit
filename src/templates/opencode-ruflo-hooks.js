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
// Failure policy: hooks NEVER break opencode. Only an explicit [BLOCKED]
// verdict from pre-bash blocks a tool call; every other error is swallowed.

import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

const HOOK_TIMEOUT_MS = 4500
const ROUTE_MIN_PROMPT = 12
const ROUTE_MAX_INJECT = 1200
const TRIVIAL_PROMPT = /^(yes|y|ok|k|sure|continue|go ahead|proceed|lgtm|next)[.!]?$/i

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

function runHook(verb, payload) {
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
      child = spawn("node", [HANDLER, verb], {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
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
function fire(verb, payload) {
  runHook(verb, payload).catch(() => {})
}

function promptText(parts) {
  if (!Array.isArray(parts)) return ""
  return parts
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim()
}

const plugin = async ({ client }) => {
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
            fire("session-restore")
            break
          case "session.compacted":
            fire("session-restore")
            break
          case "session.deleted":
            fire("session-end")
            break
        }
      } catch { /* never break opencode */ }
    },

    "chat.message": async (input, output) => {
      try {
        const prompt = promptText(output?.parts)
        if (prompt.length < ROUTE_MIN_PROMPT || TRIVIAL_PROMPT.test(prompt)) return
        const res = await runHook("route", { prompt })
        const text = (res.stdout || "").trim()
        if (!res.ok || !text || text.includes("Router not available")) return
        // A part opencode can actually persist (codex review): the validator
        // requires id/messageID/sessionID on every returned part — a bare
        // {type,text} part can fail message persistence. synthetic:true marks
        // it as injected context, not user content.
        const messageID = output?.message?.id ?? input?.messageID
        output.parts.push({
          id: `part_ruflo_route_${Date.now().toString(36)}`,
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
        if (input.tool === "bash") {
          const command = output?.args?.command
          if (typeof command !== "string" || !command) return
          const res = await runHook("pre-bash", {
            tool_name: "Bash",
            tool_input: { command },
          })
          if (!res.ok && /\[BLOCKED]/i.test(res.stderr + res.stdout)) {
            throw new Error(`[ruflo] Blocked dangerous command: ${command.slice(0, 120)}`)
          }
        } else if (input.tool === "task") {
          const description = output?.args?.description ?? output?.args?.prompt ?? ""
          fire("pre-task", { prompt: String(description).slice(0, 500) })
        }
      } catch (e) {
        if (e && e.message && e.message.startsWith("[ruflo]")) throw e
        /* anything else: allow */
      }
    },

    "tool.execute.after": async (input, output) => {
      try {
        if (input.tool === "edit" || input.tool === "write" || input.tool === "apply_patch") {
          const filePath = input?.args?.filePath ?? input?.args?.file_path ?? ""
          fire("post-edit", {
            tool_name: input.tool,
            tool_input: { file_path: filePath },
            tool_response: typeof output?.output === "string" ? output.output.slice(0, 2000) : "",
          })
        } else if (input.tool === "task") {
          fire("post-task", {
            tool_response: typeof output?.output === "string" ? output.output.slice(0, 2000) : "",
          })
        }
      } catch { /* learning hooks are best-effort */ }
    },
  }
}

export default plugin
export { plugin as RufloHooks }
