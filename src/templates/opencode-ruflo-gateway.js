// ruflo-gateway.js — lazy RuvNet catalogue access for stock OpenCode.
// Deployed to ~/.config/opencode/plugins/ by `ak setup --opencode` / `ak sync`
// (agentic-kit, src/templates/opencode-ruflo-gateway.js — managed; do not edit
// the deployed copy, sync rewrites receipt-matching content).
//
// Ruflo and Agentic QE publish hundreds of MCP operations. Advertising every schema to a
// local model on every turn makes even a simple prompt expensive. Keep the
// exact ak-managed MCP registrations as the source of truth, disable their eager
// OpenCode exposure at runtime, and expose compact discovery/call tools:
//
//   ak_ruflo_search  → find an operation in the live catalogue
//   ak_ruflo_call    → invoke one exact operation returned by search
//   ak_aqe_search    → find an Agentic QE operation in its live catalogue
//   ak_aqe_call      → invoke one exact Agentic QE operation returned by search
//   ak_skill_search → find an installed skill before stock `skill` loads it
//   ak_agent_search → find an installed specialist before stock `task` runs it
//
// The full RuvNet/AK surface remains available; only catalogue delivery changes.

import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { tool } from "@opencode-ai/plugin"

const configuredTimeout = Number(process.env.AK_OPENCODE_GATEWAY_TIMEOUT_MS)
const REQUEST_TIMEOUT_MS = Number.isFinite(configuredTimeout) && configuredTimeout > 0
  ? Math.trunc(configuredTimeout)
  : 30_000
const CHILD_EXIT_GRACE_MS = 250
const RUFLO_SERVER_NAME = "claude-flow"
const AQE_SERVER_NAME = "agentic-qe"
const SPECIALIST_AGENT_NAME = "ak-specialist"
const AK_MANAGED_MCP = Object.freeze(/* AK_MANAGED_MCP_ENTRIES */ {})
const AK_MANAGED_AGENTS = Object.freeze(/* AK_MANAGED_AGENT_CATALOG */ [])
const AK_SPECIALIST_PROMPT = /* AK_SPECIALIST_AGENT_PROMPT */ ""
const AK_CLAUDE_BLOCKS = [
  "ruflo-preamble",
  "ruflo-reference",
  "ruflo-opencode-reference",
  "ruflo-aqe-reference",
  "ruflo-providers-reference",
  "ruvnet-brain-reference",
  "ruvnet-brain-opencode-reference",
  "ruflo-dual-mode-reference",
]

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function equalValue(left, right) {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => equalValue(value, right[index]))
  }
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && equalValue(left[key], right[key]))
}

function managedEntry(cfg, name, toolPatterns, permissionPatterns) {
  const expected = AK_MANAGED_MCP[name]
  const current = cfg.mcp?.[name]
  const familyPrefixes = toolPatterns.map((pattern) => pattern.replace(/\*+$/, ""))
  const userToolPolicy = Object.keys(cfg.tools || {}).some((key) =>
    familyPrefixes.some((prefix) => key.startsWith(prefix)))
  if (userToolPolicy) return undefined
  if (!permissionPatterns.every((pattern) => cfg.permission?.[pattern] === "allow")) return undefined
  return expected && equalValue(current, expected) ? current : undefined
}

function validLocalMcp(entry) {
  return entry?.type === "local"
    && entry.enabled !== false
    && Array.isArray(entry.command)
    && entry.command.length > 0
    && entry.command.every((part) => typeof part === "string" && part.length > 0)
}

function rankTools(tools, query, limit = 3) {
  const phrase = normalize(query)
  const terms = [...new Set(phrase.split(/\s+/).filter(Boolean))]
  return tools
    .map((entry) => {
      const name = normalize(entry.name)
      const description = normalize(entry.description)
      let score = name === phrase ? 10_000 : 0
      if (phrase && name.includes(phrase)) score += 1_000
      for (const term of terms) {
        if (name === term) score += 500
        else if (name.startsWith(term)) score += 160
        else if (name.includes(term)) score += 90
        if (description.includes(term)) score += 12
      }
      return { entry, score }
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .slice(0, Math.min(Math.max(Math.trunc(limit), 1), 12))
    .map(({ entry }) => entry)
}

function compactEntry(entry) {
  const description = String(entry.description || "").replace(/\s+/g, " ").trim()
  return { name: entry.name, description: description.slice(0, 400) }
}

function parseSkillCatalog(text) {
  const match = text.match(/<available_skills>\s*([\s\S]*?)\s*<\/available_skills>/)
  if (!match) return []
  const skills = []
  const seen = new Set()
  for (const item of match[1].matchAll(/<skill>\s*([\s\S]*?)\s*<\/skill>/g)) {
    const name = item[1].match(/<name>\s*([\s\S]*?)\s*<\/name>/)?.[1]?.trim()
    const description = item[1].match(/<description>\s*([\s\S]*?)\s*<\/description>/)?.[1]?.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    skills.push({ name, description: description || "" })
  }
  return skills
}

function compactSystem(text) {
  let result = text
  for (const id of AK_CLAUDE_BLOCKS) {
    result = result.replace(
      new RegExp(`<!-- BEGIN ${id} -->[\\s\\S]*?<!-- END ${id} -->`, "g"),
      "",
    )
  }
  return result.replace(
    /<available_skills>\s*[\s\S]*?\s*<\/available_skills>/g,
    "<available_skills_lazy>Installed skills remain available. Use ak_skill_search to find one, " +
      "then call the stock skill tool with its exact name.</available_skills_lazy>",
  )
}

function rewriteLazyToolReferences(text, capabilities) {
  const call = (family, name) =>
    `\`ak_${family}_call\` with \`name=${JSON.stringify(name)}\` and \`arguments_json\` set to one JSON object string`
  let result = String(text)
  if (capabilities.ruflo) {
    result = result
    .replace(/mcp__(?:claude-flow|claude_flow|ruflo|plugin_ruflo-core_ruflo)__\*/g,
      () => "the Ruflo operation selected with `ak_ruflo_search`, then invoked through `ak_ruflo_call`")
    .replace(/\b(?:claude-flow|claude_flow)_\*/g,
      () => "the Ruflo operation selected with `ak_ruflo_search`, then invoked through `ak_ruflo_call`")
    .replace(/mcp__(?:claude-flow|claude_flow|ruflo|plugin_ruflo-core_ruflo)__([A-Za-z0-9_./:-]+)/g,
      (_match, name) => call("ruflo", name))
    .replace(/\b(?:claude-flow|claude_flow)_([A-Za-z0-9_./:-]+)/g,
      (_match, name) => call("ruflo", name))
  }
  if (capabilities.aqe) {
    result = result
    .replace(/mcp__(?:agentic-qe|agentic_qe)__\*/g,
      () => "the Agentic QE operation selected with `ak_aqe_search`, then invoked through `ak_aqe_call`")
    .replace(/\b(?:agentic-qe|agentic_qe)_\*/g,
      () => "the Agentic QE operation selected with `ak_aqe_search`, then invoked through `ak_aqe_call`")
    .replace(/mcp__(?:agentic-qe|agentic_qe)__([A-Za-z0-9_./:-]+)/g,
      (_match, name) => call("aqe", name))
    .replace(/\b(?:agentic-qe|agentic_qe)_([A-Za-z0-9_./:-]+)/g,
      (_match, name) => call("aqe", name))
  }
  return result
}

function optionalMcpFamilies(text) {
  const managed = new Set([
    "claude-flow",
    "claude_flow",
    "ruflo",
    "plugin_ruflo-core_ruflo",
    "agentic-qe",
    "agentic_qe",
  ])
  return [...new Set(
    [...String(text).matchAll(/\bmcp__([A-Za-z0-9_-]+)__[A-Za-z0-9_./:-]+/g)]
      .map((match) => match[1])
      .filter((family) => !managed.has(family)),
  )].sort()
}

function validateCallArguments(entry, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error(`Invalid arguments for ${entry.name}: expected one JSON object`)
  }
  const required = Array.isArray(entry.inputSchema?.required)
    ? entry.inputSchema.required.filter((key) => typeof key === "string")
    : []
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(args, key))
  if (missing.length) {
    throw new Error(
      `Invalid arguments for ${entry.name}: missing required argument${missing.length === 1 ? "" : "s"} ` +
      `${missing.join(", ")}. Use the inputSchema returned by the matching search tool.`,
    )
  }
}

function parseCallArgumentsJson(name, encoded) {
  if (typeof encoded !== "string") {
    throw new Error(
      `Invalid arguments_json for ${name}: expected one JSON-encoded object string`,
    )
  }
  let decoded
  try {
    decoded = JSON.parse(encoded)
  } catch (error) {
    throw new Error(`Invalid arguments_json for ${name}: ${error.message}`, { cause: error })
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error(`Invalid arguments_json for ${name}: decoded value must be one JSON object`)
  }
  return decoded
}

async function askForTool(context, permission, pattern, metadata = {}) {
  if (!context?.ask) throw new Error(`${permission} cannot enforce the OpenCode permission policy`)
  await context.ask({
    permission,
    patterns: [String(pattern)],
    always: [String(pattern)],
    metadata,
  })
}

async function askForFamilyCall(context, gatewayPermission, familyNames, operation) {
  void familyNames
  await askForTool(context, gatewayPermission, operation, { operation })
}

function directPermissionAction(value) {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return typeof value["*"] === "string" ? value["*"] : undefined
}

function projectGatewayCallPolicy(cfg, gatewayPermission, familyPrefixes) {
  const existing = cfg.permission?.[gatewayPermission]
  const projected = existing && typeof existing === "object" && !Array.isArray(existing)
    ? { ...existing }
    : { "*": typeof existing === "string" ? existing : "allow" }
  for (const [permission, value] of Object.entries(cfg.permission || {})) {
    const prefix = familyPrefixes.find((candidate) => permission.startsWith(candidate))
    if (!prefix) continue
    const action = directPermissionAction(value)
    const operationPattern = permission.slice(prefix.length)
    if (operationPattern === "*" && existing !== undefined) continue
    if (action) projected[operationPattern] = action
  }
  return projected
}

function hideDirectFamily(permission, patterns) {
  for (const pattern of patterns) delete permission[pattern]
  for (const pattern of patterns) permission[pattern] = "deny"
}

class RufloGatewayClient {
  constructor(label) {
    this.label = label
    this.command = null
    this.args = []
    this.environment = {}
    this.child = undefined
    this.starting = undefined
    this.initialized = false
    this.nextID = 1
    this.pending = new Map()
    this.tools = undefined
    this.cataloging = undefined
    this.stderr = []
  }

  configure(entry) {
    const command = entry?.command
    if (entry?.type !== "local" || !Array.isArray(command) || !command.length
        || command.some((part) => typeof part !== "string" || !part)) {
      this.command = null
      this.args = []
      this.environment = {}
      return false
    }
    if (this.child || this.starting) throw new Error(`${this.label} gateway cannot be reconfigured after use`)
    this.command = command[0]
    this.args = command.slice(1)
    this.environment = entry.environment && typeof entry.environment === "object"
      ? { ...entry.environment }
      : {}
    return true
  }

  async start() {
    if (this.starting) return this.starting
    if (this.child && !this.child.killed && this.initialized) return
    if (!this.command) {
      throw new Error(`ak-managed ${this.label} MCP is missing or is not a local command; run \`ak sync\``)
    }
    this.starting = this.startInner().finally(() => { this.starting = undefined })
    return this.starting
  }

  async startInner() {
    const child = spawn(this.command, this.args, {
      env: { ...process.env, ...this.environment },
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    })
    this.child = child
    createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line))
    createInterface({ input: child.stderr }).on("line", (line) => {
      this.stderr.push(line)
      if (this.stderr.length > 20) this.stderr.shift()
    })
    child.once("error", (error) => this.handleExit(child, error))
    child.once("exit", (code, signal) => {
      this.handleExit(child, new Error(`${this.label} MCP exited (code=${code ?? "null"}, signal=${signal ?? "null"})`))
    })

    try {
      await this.requestRaw("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "opencode-ak-lazy-gateway", version: "1" },
      })
      this.notify("notifications/initialized", {})
      this.initialized = true
    } catch (error) {
      await this.terminateChild(child, error)
      throw error
    }
  }

  handleLine(line) {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message.id === undefined || message.id === null) return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    pending.signal?.removeEventListener("abort", pending.abort)
    if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)))
    else pending.resolve(message.result)
  }

  handleExit(child, error) {
    if (this.child !== child) return
    this.child = undefined
    this.initialized = false
    this.tools = undefined
    this.cataloging = undefined
    if (child?.stdin && !child.stdin.destroyed) child.stdin.destroy()
    const detail = this.stderr.length ? `\n${this.stderr.join("\n")}` : ""
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.signal?.removeEventListener("abort", pending.abort)
      pending.reject(new Error(`${error.message}${detail}`))
    }
    this.pending.clear()
  }

  async terminateChild(child, error, { graceful = false } = {}) {
    if (!child) return
    let exited = child.exitCode !== null || child.signalCode !== null
    let resolveExit
    const exit = new Promise((resolve) => { resolveExit = resolve })
    const onExit = () => { exited = true; resolveExit() }
    child.once("exit", onExit)
    child.once("close", onExit)
    if (this.child === child) this.handleExit(child, error)
    try {
      if (graceful && child.stdin?.writable) child.stdin.end()
      else if (child.stdin && !child.stdin.destroyed) child.stdin.destroy()
    } catch { /* continue to process termination */ }

    const wait = async (milliseconds) => {
      if (exited || child.exitCode !== null || child.signalCode !== null) return true
      return Promise.race([
        exit.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), milliseconds)),
      ])
    }
    if (graceful && await wait(CHILD_EXIT_GRACE_MS)) return
    if (!exited) {
      try { child.kill("SIGTERM") } catch { /* escalate below */ }
    }
    if (await wait(CHILD_EXIT_GRACE_MS)) return
    try { child.kill("SIGKILL") } catch { /* final wait reports failure */ }
    if (!await wait(1_000)) {
      throw new Error(`${this.label} MCP process could not be reaped after SIGKILL`)
    }
  }

  notify(method, params) {
    if (!this.child?.stdin?.writable) throw new Error(`${this.label} MCP is not writable`)
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`)
  }

  requestRaw(method, params, signal) {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error(`${this.label} MCP is not running`))
    if (signal?.aborted) return Promise.reject(new Error(`${this.label} request cancelled`))
    const id = this.nextID++
    return new Promise((resolve, reject) => {
      const cancel = (reason) => {
        if (!this.pending.delete(id)) return
        try { this.notify("notifications/cancelled", { requestId: id, reason }) } catch { /* best effort */ }
      }
      const timer = setTimeout(() => {
        const reason = `${this.label} MCP request timed out after ${REQUEST_TIMEOUT_MS}ms: ${method}`
        cancel(reason)
        signal?.removeEventListener("abort", abort)
        reject(new Error(reason))
      }, REQUEST_TIMEOUT_MS)
      const abort = () => {
        clearTimeout(timer)
        const reason = `${this.label} request cancelled`
        cancel(reason)
        reject(new Error(reason))
      }
      signal?.addEventListener("abort", abort, { once: true })
      this.pending.set(id, { resolve, reject, timer, signal, abort })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    })
  }

  async request(method, params, signal) {
    await this.start()
    return this.requestRaw(method, params, signal)
  }

  async catalog(signal) {
    if (this.tools) return this.tools
    if (this.cataloging) return this.cataloging
    this.cataloging = this.loadCatalog(signal).finally(() => { this.cataloging = undefined })
    return this.cataloging
  }

  async loadCatalog(signal) {
    const tools = []
    const cursors = new Set()
    let cursor
    do {
      const result = await this.request("tools/list", cursor ? { cursor } : {}, signal)
      if (!Array.isArray(result?.tools)) throw new Error(`${this.label} MCP returned an invalid tool catalogue`)
      tools.push(...result.tools)
      const next = result.nextCursor
      if (next !== undefined && (typeof next !== "string" || !next || cursors.has(next))) {
        throw new Error(`${this.label} MCP returned an invalid or repeated catalogue cursor`)
      }
      cursor = next
      if (cursor) cursors.add(cursor)
    } while (cursor)
    if (!tools.length) throw new Error(`${this.label} MCP returned an empty tool catalogue`)
    this.tools = tools
    return this.tools
  }

  async search(query, limit, signal) {
    return rankTools(await this.catalog(signal), query, limit)
  }

  async call(name, args, signal) {
    const catalog = await this.catalog(signal)
    const entry = catalog.find((candidate) => candidate.name === name)
    if (!entry) {
      throw new Error(`Unknown ${this.label} operation: ${name}`)
    }
    validateCallArguments(entry, args)
    return this.request("tools/call", { name, arguments: args || {} }, signal)
  }

  async close() {
    const child = this.child
    if (!child) return
    await this.terminateChild(child, new Error(`${this.label} MCP gateway closed`), { graceful: true })
  }
}

function renderToolResult(result, errorPrefix) {
  const blocks = Array.isArray(result?.content) ? result.content : []
  const text = blocks
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("\n")
  if (text && blocks.every((block) => block?.type === "text")
      && result?.structuredContent === undefined) {
    return result.isError ? `${errorPrefix}_ERROR: ${text}` : text
  }
  return JSON.stringify(result ?? null, null, 2)
}

/** @type {import("@opencode-ai/plugin").Plugin} */
export default async function rufloGateway() {
  const rufloClient = new RufloGatewayClient("Ruflo")
  const aqeClient = new RufloGatewayClient("Agentic QE")
  const skillCatalogs = new Map()
  let available = { ruflo: false, aqe: false, brain: false, agents: false }
  const plugin = {
    config(cfg) {
      const rufloEntry = managedEntry(
        cfg, RUFLO_SERVER_NAME,
        ["claude-flow_*", "claude_flow_*"],
        ["claude-flow_*", "claude_flow_*"],
      )
      const aqeEntry = managedEntry(
        cfg, AQE_SERVER_NAME,
        ["agentic-qe_*", "agentic_qe_*"],
        ["agentic-qe_*", "agentic_qe_*"],
      )
      available = {
        ruflo: rufloClient.configure(rufloEntry),
        aqe: aqeClient.configure(aqeEntry),
        brain: validLocalMcp(cfg.mcp?.["ruvnet-brain"]),
        agents: AK_MANAGED_AGENTS.length > 0
          && typeof cfg.agent?.[SPECIALIST_AGENT_NAME]?.prompt === "string"
          && cfg.agent[SPECIALIST_AGENT_NAME].prompt.trim() === AK_SPECIALIST_PROMPT.trim(),
      }
      if (!available.ruflo) {
        delete plugin.tool.ak_ruflo_search
        delete plugin.tool.ak_ruflo_call
      }
      if (!available.aqe) {
        delete plugin.tool.ak_aqe_search
        delete plugin.tool.ak_aqe_call
      }
      if (!available.agents) {
        delete plugin.tool.ak_agent_search
        delete plugin.tool.ak_agent_load
      }

      // Blacklist direct catalogue exposure. The gateway tools below remain
      // explicit and small; custom user policy for them is preserved.
      cfg.tools = {
        ...(cfg.tools || {}),
        ...(available.ruflo ? { "claude-flow_*": false, "claude_flow_*": false } : {}),
        ...(available.aqe ? { "agentic-qe_*": false, "agentic_qe_*": false } : {}),
      }
      const permission = {
        ...(cfg.permission || {}),
        ...(available.ruflo ? {
          ak_ruflo_search: cfg.permission?.ak_ruflo_search ?? "allow",
          ak_ruflo_call: projectGatewayCallPolicy(
            cfg, "ak_ruflo_call", ["claude-flow_", "claude_flow_"],
          ),
        } : {}),
        ...(available.aqe ? {
          ak_aqe_search: cfg.permission?.ak_aqe_search ?? "allow",
          ak_aqe_call: projectGatewayCallPolicy(
            cfg, "ak_aqe_call", ["agentic-qe_", "agentic_qe_"],
          ),
        } : {}),
        ak_skill_search: cfg.permission?.ak_skill_search ?? "allow",
        ...(available.agents ? {
          ak_agent_search: cfg.permission?.ak_agent_search ?? "allow",
          ak_agent_load: cfg.permission?.ak_agent_load ?? "allow",
        } : {}),
      }
      if (available.ruflo) hideDirectFamily(permission, ["claude-flow_*", "claude_flow_*"])
      if (available.aqe) hideDirectFamily(permission, ["agentic-qe_*", "agentic_qe_*"])
      cfg.permission = permission
    },
    event: async ({ event }) => {
      if (event?.type === "session.deleted") {
        skillCatalogs.delete(event.properties?.sessionID ?? event.properties?.info?.id)
      }
    },
    "experimental.chat.system.transform"(input, output) {
      const discovered = output.system.flatMap((text) => parseSkillCatalog(text))
      if (input?.sessionID) skillCatalogs.set(input.sessionID, discovered)
      const transformed = output.system.map((text) => compactSystem(text))
      const routes = []
      if (available.ruflo) routes.push("ak_ruflo_search then ak_ruflo_call for the complete live Ruflo catalogue")
      if (available.aqe) {
        routes.push(
          "ak_aqe_search then ak_aqe_call for Agentic QE; initialize the fleet first and never claim success without its tool result",
        )
      }
      if (available.brain) {
        routes.push(
          "direct RuvNet Brain search before any rUv capability claim, citing the returned source instead of prior knowledge",
        )
      }
      const guidance = "Agentic Kit for OpenCode: " +
        `${routes.length ? `use ${routes.join(", ")}. ` : ""}` +
        "Use ak_skill_search then skill for installed skills. " +
        `${available.agents ? "Use ak_agent_search then stock task with ak-specialist for specialist profiles. " : ""}` +
        "Discovery is lazy; configured capability is preserved."
      if (transformed.length) transformed[0] = `${transformed[0]}\n\n${guidance}`
      else transformed.push(guidance)
      output.system.splice(0, output.system.length, ...transformed)
    },
    dispose: async () => {
      await Promise.all([rufloClient.close(), aqeClient.close()])
    },
    "tool.execute.after"(input, output) {
      if (input.tool !== "skill" || typeof output?.output !== "string") return
      const rewritten = rewriteLazyToolReferences(output.output, available)
      if (rewritten === output.output) return
      output.output =
        "[Agentic Kit OpenCode adaptation: direct Ruflo/AQE operation names below use the lazy gateway.]\n" +
        rewritten
    },
    tool: {
      ak_skill_search: tool({
        description:
          "Search installed OpenCode skills. Then call stock skill with the exact returned name; " +
          "instructions load on demand.",
        args: {
          query: tool.schema.string().describe("Skill capability needed"),
          limit: tool.schema.number().optional().describe("Results to return (default 3, max 12)"),
        },
        async execute(args, context) {
          await askForTool(context, "ak_skill_search", args.query, { query: args.query })
          const skillCatalog = skillCatalogs.get(context?.sessionID) ?? []
          if (!skillCatalog.length) return "AK_SKILL_SEARCH_FAILED: OpenCode skill catalogue was not found"
          return JSON.stringify(
            rankTools(skillCatalog, args.query, args.limit ?? 3).map(compactEntry),
            null,
            2,
          )
        },
      }),
      ak_agent_search: tool({
        description:
          "Search Agentic Kit specialist profiles. Then call stock task with " +
          "subagent_type=\"ak-specialist\" and the exact returned profile name.",
        args: {
          query: tool.schema.string().describe("Agent capability needed"),
          limit: tool.schema.number().optional().describe("Results to return (default 3, max 12)"),
        },
        async execute(args, context) {
          await askForTool(context, "ak_agent_search", args.query, { query: args.query })
          if (!AK_MANAGED_AGENTS.length) return "AK_AGENT_SEARCH_FAILED: Agentic Kit profile catalogue was not found"
          return JSON.stringify(
            {
              instruction:
                "Choose one profile, then call the stock task tool with subagent_type=\"ak-specialist\". " +
                "Begin its prompt with `PROFILE: <exact name>` followed by the user's task.",
              matches: rankTools(AK_MANAGED_AGENTS, args.query, args.limit ?? 3).map(compactEntry),
            },
            null,
            2,
          )
        },
      }),
      ak_agent_load: tool({
        description:
          "Load one receipt-owned Agentic Kit profile selected by ak_agent_search. " +
          "Use only inside the stock ak-specialist subagent.",
        args: {
          name: tool.schema.string().describe("Exact profile name returned by ak_agent_search"),
        },
        async execute(args, context) {
          await askForTool(context, "ak_agent_load", args.name, { profile: args.name })
          const entry = AK_MANAGED_AGENTS.find((candidate) => candidate.name === args.name)
          if (!entry) return `AK_AGENT_LOAD_FAILED: Unknown Agentic Kit profile: ${args.name}`
          const optionalFamilies = optionalMcpFamilies(entry.body)
          const dependencyNote = optionalFamilies.length
            ? "Optional external MCP families named by this profile: " +
              `${optionalFamilies.map((family) => `\`${family}\``).join(", ")}. ` +
              "This Agentic Kit OpenCode adapter does not provision them. If one is unavailable, " +
              "report that dependency instead of inventing a tool call or result."
            : "If this profile names an optional tool that is unavailable, report that dependency " +
              "instead of inventing a tool call or result."
          return [
            `Agentic Kit specialist profile: ${entry.name}`,
            "Treat the following receipt-owned profile as your specialist instructions for this task. " +
              dependencyNote,
            rewriteLazyToolReferences(entry.body, available),
          ].join("\n\n")
        },
      }),
      ak_ruflo_search: tool({
        description:
          "Search the live Ruflo catalogue for AgentDB memory, swarms, routing, hooks, workflows, " +
          "or rUv coordination. Then use ak_ruflo_call.",
        args: {
          query: tool.schema.string().describe("Capability needed, such as 'semantic project memory search'"),
          limit: tool.schema.number().optional().describe("Results to return (default 3, max 12)"),
        },
        async execute(args, context) {
          try {
            await askForTool(context, "ak_ruflo_search", args.query, { query: args.query })
            const matches = await rufloClient.search(args.query, args.limit ?? 3, context.abort)
            if (!matches.length) return `No Ruflo operations matched: ${args.query}`
            return JSON.stringify({
              instruction:
                "Choose one match, then call ak_ruflo_call. Copy its name exactly. Set arguments_json to " +
                "one JSON object encoded as a string, containing every required field from inputSchema.",
              matches: matches.map((entry) => ({
                name: entry.name,
                description: entry.description,
                inputSchema: entry.inputSchema,
              })),
            }, null, 2)
          } catch (error) {
            return `RUFLO_SEARCH_FAILED: ${error.message}`
          }
        },
      }),
      ak_ruflo_call: tool({
        description:
          "Invoke an operation returned by ak_ruflo_search. Pass arguments_json as one JSON object " +
          "string matching its inputSchema.",
        args: {
          name: tool.schema.string().describe("Exact operation name returned by ak_ruflo_search"),
          arguments_json: tool.schema.string().describe(
            "One JSON-encoded object matching the selected inputSchema; use \"{}\" only for no-argument operations",
          ),
        },
        async execute(args, context) {
          try {
            await askForFamilyCall(
              context, "ak_ruflo_call", ["claude-flow", "claude_flow"], args.name,
            )
            const decoded = parseCallArgumentsJson(args.name, args.arguments_json)
            return renderToolResult(await rufloClient.call(args.name, decoded, context.abort), "RUFLO")
          } catch (error) {
            return `RUFLO_CALL_FAILED: ${error.message}`
          }
        },
      }),
      ak_aqe_search: tool({
        description:
          "Search live Agentic QE operations for fleets, tests, coverage, quality, security, or learning. " +
          "Then use ak_aqe_call; call fleet_init first when required.",
        args: {
          query: tool.schema.string().describe("Quality-engineering capability needed"),
          limit: tool.schema.number().optional().describe("Results to return (default 3, max 12)"),
        },
        async execute(args, context) {
          try {
            await askForTool(context, "ak_aqe_search", args.query, { query: args.query })
            const matches = await aqeClient.search(args.query, args.limit ?? 3, context.abort)
            if (!matches.length) return `No Agentic QE operations matched: ${args.query}`
            return JSON.stringify({
              instruction:
                "Choose one match, then call ak_aqe_call. Copy its name exactly. Set arguments_json to " +
                "one JSON object encoded as a string, containing every required field from inputSchema. " +
                "Call fleet_init before operations whose schema or description requires an initialized fleet.",
              matches: matches.map((entry) => ({
                name: entry.name,
                description: entry.description,
                inputSchema: entry.inputSchema,
              })),
            }, null, 2)
          } catch (error) {
            return `AQE_SEARCH_FAILED: ${error.message}`
          }
        },
      }),
      ak_aqe_call: tool({
        description:
          "Invoke an operation returned by ak_aqe_search. Pass arguments_json as one JSON object " +
          "string matching its inputSchema.",
        args: {
          name: tool.schema.string().describe("Exact Agentic QE operation name returned by ak_aqe_search"),
          arguments_json: tool.schema.string().describe(
            "One JSON-encoded object matching the selected inputSchema; use \"{}\" only for no-argument operations",
          ),
        },
        async execute(args, context) {
          try {
            await askForFamilyCall(
              context, "ak_aqe_call", ["agentic-qe", "agentic_qe"], args.name,
            )
            const decoded = parseCallArgumentsJson(args.name, args.arguments_json)
            return renderToolResult(await aqeClient.call(args.name, decoded, context.abort), "AQE")
          } catch (error) {
            return `AQE_CALL_FAILED: ${error.message}`
          }
        },
      }),
    },
  }
  return plugin
}
