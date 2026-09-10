/**
 * dsh-xianyu — MCP connection supervisor (stdio transport).
 *
 * Drives the goofish-cli MCP server as a stdio subprocess. Discovers the
 * server's tools and registers them on `ctx.tools` under deterministic
 * server-qualified names (`mcp__goofish__<rawName>`). When `readOnly` is on
 * (default), write-capable tools are filtered out so the agent can never
 * publish / delete / send / overwrite login from an MCP call.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ListToolsResultSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Context } from '@deepseek-ai/cordis'
import type { GoofishConfig } from './store.ts'
import { extendedPath } from './child-env.ts'

/** Raw call result record. */
const RawCallToolResultSchema = z.record(z.string(), z.unknown())

/** DeepSeek function-name contract: at most 64 chars, [A-Za-z0-9_-]. */
const MAX_PUBLIC_NAME_LENGTH = 64
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
/** Characters that normalize losslessly to `_` (goofish names are snake_case). */
const SAFE_NORMALIZE = /^[A-Za-z0-9_.\-/]+$/
const HASH_LENGTH = 12
const TOOL_CALL_TIMEOUT_MS = 90_000
const GENERATION_CLOSE_TIMEOUT_MS = 5_000

const RECONNECT = { initialDelayMs: 1_000, maxDelayMs: 30_000, maxAttempts: 10 } as const

/**
 * Read-only allowlist (the only tools the agent may call when `readOnly` is
 * on). Write-capable and sensitive tools are deliberately excluded:
 * item_publish / item_delete / media_upload / message_send / auth_login /
 * auth_reset_guard / message_watch (blocking) / skills_install.
 */
export const READ_ONLY_TOOLS = new Set([
  'auth_status',
  'item_get',
  'item_view',
  'item_list',
  'search_items',
  'message_history',
  'message_list_chats',
  'location_default',
  'category_recommend',
])

/** Derive the model-facing public name (mcp__goofish__<rawName>). */
export function publicToolName(rawName: string): string {
  const joined = `mcp__goofish__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (SAFE_NORMALIZE.test(rawName) && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`goofish\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/** Extract readable text from an MCP content array. */
function extractText(mcpContent: unknown, toolName: string): string {
  if (!Array.isArray(mcpContent)) return `(${toolName} returned non-content output)`
  const parts: string[] = []
  for (const value of mcpContent) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      parts.push('[unsupported content type: unknown]')
      continue
    }
    const block = value as Record<string, unknown>
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') parts.push(block.text)
        break
      case 'image':
        parts.push(`[image: ${typeof block.mimeType === 'string' ? block.mimeType : 'unknown'}, content discarded]`)
        break
      case 'resource':
      case 'resource_link':
        parts.push('[resource: content discarded]')
        break
      default:
        parts.push(`[unsupported content type: ${String(block.type)}]`)
    }
  }
  return parts.join('\n') || `(${toolName} returned no text content)`
}

/** Connection supervisor handle. */
export interface McpSupervisor {
  start(): Promise<void>
  restart(): Promise<void>
  isConnected(): boolean
  toolCount(): number
  listTools(): Promise<string[]>
  dispose(): Promise<void>
}

/** Build the stdio server parameters from config (command + args + env). */
export function buildServerParams(cfg: GoofishConfig): StdioServerParameters {
  const args = [...cfg.args]
  const env = { ...process.env } as Record<string, string>
  // A launchd-started DSH has only /usr/bin:/bin, which hides goofish-mcp.
  env.PATH = extendedPath()
  for (const [k, v] of Object.entries(cfg.env)) env[k] = v
  if (cfg.command.trim() === '') return { command: 'goofish-mcp', args, env }
  return { command: cfg.command, args, env }
}

/**
 * Decide whether a server tool should be registered, honouring the read-only
 * filter.
 */
function shouldRegister(toolName: string, cfg: GoofishConfig): boolean {
  if (cfg.readOnly !== false) return READ_ONLY_TOOLS.has(toolName)
  return true
}

export function createSupervisor(ctx: Context, store: { load(): Promise<GoofishConfig> }): McpSupervisor {
  const label = 'goofish-mcp'
  let client: Client | null = null
  let clientClosed: Promise<void> | null = null
  let transport: StdioClientTransport | null = null
  let disposers = new Map<string, () => void>()
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let failedAttempts = 0
  let disposed = false
  let syncChain: Promise<unknown> = Promise.resolve()
  let lastConfig: GoofishConfig = { command: 'goofish-mcp', args: [], env: {}, readOnly: true }

  const isCurrent = (generation: Client): boolean => !disposed && client === generation

  function enqueueSync(generation: Client): Promise<void> {
    const run = syncChain.then(async () => {
      if (!isCurrent(generation)) return
      disposers = await syncTools(generation)
    })
    syncChain = run.catch(() => {})
    return run
  }

  async function syncTools(generation: Client): Promise<Map<string, () => void>> {
    const tools = await listToolsAll(generation)
    const definitions = tools
      .filter((tool) => shouldRegister(tool.name, lastConfig))
      .map((tool) => ({
        name: publicToolName(tool.name),
        description: tool.description ?? '',
        parameters: tool.inputSchema,
        output: {
          schema: {
            type: 'object' as const,
            properties: {
              content: { type: 'array' as const, items: {} },
              structuredContent: {},
            },
            required: ['content'],
            additionalProperties: false,
          },
          render(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
            const content = typeof value === 'object' && value !== null
              ? (value as Record<string, unknown>).content
              : undefined
            return [{ type: 'text', text: extractText(content, tool.name) }]
          },
        },
        execute: async (args: unknown, exec: { signal: AbortSignal }): Promise<unknown> => {
          const cleanArgs = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
          const result = await callToolUncached(generation, tool.name, cleanArgs, exec.signal)
          if (!Array.isArray(result.content)) {
            const text = 'toolResult' in result ? JSON.stringify(result.toolResult) : '(no output)'
            if (result.isError === true) throw new Error(text)
            return { content: [{ type: 'text', text }] }
          }
          if (result.isError === true) throw new Error(extractText(result.content, tool.name))
          return { content: result.content }
        },
      }))
    for (const dispose of disposers.values()) dispose()
    const next = new Map<string, () => void>()
    for (const definition of definitions) next.set(definition.name, ctx.tools.register(definition))
    return next
  }

  async function listToolsAll(generation: Client): Promise<Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>> {
    const tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> = []
    let cursor: string | undefined
    do {
      const response = await generation.request({ method: 'tools/list', ...(cursor === undefined ? {} : { params: { cursor } }) }, ListToolsResultSchema)
      for (const tool of response.tools) tools.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema as Record<string, unknown> })
      cursor = response.nextCursor
    } while (cursor !== undefined)
    return tools
  }

  async function callToolUncached(
    generation: Client,
    rawName: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ content?: unknown; isError?: boolean; toolResult?: unknown }> {
    const result = await generation.request(
      { method: 'tools/call', params: { name: rawName, arguments: args } },
      RawCallToolResultSchema,
      { signal, timeout: TOOL_CALL_TIMEOUT_MS },
    )
    return result as { content?: unknown; isError?: boolean; toolResult?: unknown }
  }

  function generationDown(generation: Client): void {
    if (!isCurrent(generation)) return
    client = null
    clientClosed = null
    transport = null
    scheduleReconnect()
  }

  function waitForClose(closed: Promise<void>): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), GENERATION_CLOSE_TIMEOUT_MS)
      timeout.unref()
      closed.then(() => { clearTimeout(timeout); resolve(true) })
    })
  }

  function scheduleReconnect(): void {
    if (disposed) return
    if (failedAttempts >= RECONNECT.maxAttempts) {
      syncChain = syncChain.then(() => {
        for (const dispose of disposers.values()) dispose()
        disposers = new Map()
      })
      ctx.logger.error(`${label}: giving up after ${RECONNECT.maxAttempts} reconnect attempts — tools unregistered`)
      return
    }
    const delayMs = Math.min(RECONNECT.maxDelayMs, RECONNECT.initialDelayMs * 2 ** failedAttempts)
    failedAttempts += 1
    ctx.logger.warn(`${label}: server exited; retrying in ${delayMs}ms (attempt ${failedAttempts}/${RECONNECT.maxAttempts})`)
    reconnectTimer = setTimeout(() => { reconnectTimer = null; void connectGeneration(false) }, delayMs)
    reconnectTimer.unref()
  }

  async function connectGeneration(startup: boolean): Promise<void> {
    if (disposed) return
    const cfg = await store.load()
    lastConfig = cfg
    const generation = new Client({ name: 'dsh-xianyu', version: '0.1.0' }, { capabilities: {} })
    let resolveClosed!: () => void
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve })
    let attemptSettled = false
    let closeObserved = false
    client = generation
    clientClosed = closed
    generation.onclose = () => {
      closeObserved = true
      resolveClosed()
      if (attemptSettled) generationDown(generation)
    }
    generation.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      if (!isCurrent(generation)) return
      try { await enqueueSync(generation) } catch (error) { if (!disposed) ctx.logger.error(`${label}: tool re-sync failed: ${String(error)}`) }
    })
    try {
      const params = buildServerParams(cfg)
      transport = new StdioClientTransport(params)
      await generation.connect(transport)
      if (closeObserved) { attemptSettled = true; generationDown(generation); return }
      await enqueueSync(generation)
    } catch (error) {
      if (isCurrent(generation)) ctx.logger.warn(`${label}: connection attempt failed: ${String(error)}`)
      try { await generation.close() } catch {}
      const quiesced = closeObserved || await waitForClose(closed)
      attemptSettled = true
      if (!isCurrent(generation)) return
      if (!quiesced) { client = null; clientClosed = null; ctx.logger.error(`${label}: failed generation did not close — reconnect stopped`); return }
      generationDown(generation)
      return
    }
    attemptSettled = true
    if (closeObserved) { generationDown(generation); return }
    if (!isCurrent(generation)) return
    await store.load().then((c) => (c.lastConnectedAt !== undefined ? c.lastConnectedAt : null)).catch(() => null)
    if (failedAttempts > 0) ctx.logger.info(`${label}: reconnected and re-synced tools (attempt ${failedAttempts}/${RECONNECT.maxAttempts})`)
  }

  async function restart(): Promise<void> {
    if (disposed) return
    failedAttempts = 0
    const old = client
    if (old !== null) {
      client = null
      clientClosed = null
      transport = null
      try { await old.close() } catch {}
    }
    await connectGeneration(false)
  }

  return {
    async start(): Promise<void> { failedAttempts = 0; await connectGeneration(true) },
    restart() { return restart() },
    isConnected(): boolean { return client !== null },
    toolCount(): number { return disposers.size },
    async listTools(): Promise<string[]> {
      if (client === null) throw new Error('闲鱼 MCP 未连接。')
      const tools = await listToolsAll(client)
      return tools.map((tool) => tool.name).filter((name) => shouldRegister(name, lastConfig))
    },
    async dispose(): Promise<void> {
      disposed = true
      if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null }
      const current = client
      const currentClosed = clientClosed
      client = null
      clientClosed = null
      if (current !== null) {
        try { await current.close() } catch {}
        if (currentClosed !== null && !await waitForClose(currentClosed)) ctx.logger.error(`${label}: generation did not close within ${GENERATION_CLOSE_TIMEOUT_MS}ms during disposal`)
      }
      await syncChain
      for (const dispose of disposers.values()) dispose()
      disposers = new Map()
    },
  }
}
