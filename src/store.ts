/**
 * dsh-xianyu — config store (~/.dsh/dsh-xianyu.json, 0600).
 *
 * Holds the stdio server launch parameters and the read-only filter toggle.
 * The actual goofish login session lives with the CLI at
 * ~/.goofish-cli/cookies.json (written by `goofish auth login`); this plugin
 * never stores or reads the goofish cookie itself.
 */
import { readFile, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Default goofish stdio server entrypoint (on PATH via uv tool install). */
export const DEFAULT_COMMAND = 'goofish-mcp'

/** Diagnostics pulled from the goofish CLI (masked, never the cookie). */
export interface GoofishView {
  configured: boolean
  readOnly: boolean
  command: string
  args: string[]
  envKeys: string[]
  connected: boolean
  toolCount: number
  lastConnectedAt: number | null
  configPath: string
  cookiePath: string
  loginHint: string
}

/** Plugin config persisted to disk. */
export interface GoofishConfig {
  command: string
  args: string[]
  env: Record<string, string>
  readOnly: boolean
  lastConnectedAt?: number
}

export const configPath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-xianyu.json')
/** Where the goofish CLI keeps its login cookie (auth via `goofish auth login`). */
export const cookiePath = join(homedir(), '.goofish-cli', 'cookies.json')

const DEFAULTS: Omit<GoofishConfig, 'command' | 'args'> = {
  env: {},
  readOnly: true,
}

/** Read + normalize config (returns defaults when the file is missing/invalid). */
export async function load(): Promise<GoofishConfig> {
  try {
    const raw = await readFile(configPath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<GoofishConfig>
    return {
      command: typeof parsed.command === 'string' && parsed.command.trim() !== '' ? parsed.command.trim() : DEFAULT_COMMAND,
      args: Array.isArray(parsed.args) ? parsed.args.map(String) : [],
      env: parsed.env && typeof parsed.env === 'object' ? parsed.env as Record<string, string> : {},
      readOnly: typeof parsed.readOnly === 'boolean' ? parsed.readOnly : DEFAULTS.readOnly,
      lastConnectedAt: typeof parsed.lastConnectedAt === 'number' ? parsed.lastConnectedAt : undefined,
    }
  } catch {
    // Record lastConnectedAt so a reconnect that sets it survives a restart.
    return { command: DEFAULT_COMMAND, args: [], env: {}, readOnly: true, lastConnectedAt: undefined }
  }
}

/** Persist config (0600). */
export async function save(cfg: GoofishConfig): Promise<void> {
  const data: GoofishConfig = {
    command: cfg.command,
    args: cfg.args,
    env: cfg.env,
    readOnly: cfg.readOnly !== false,
    lastConnectedAt: cfg.lastConnectedAt ?? Date.now(),
  }
  await writeFile(configPath, JSON.stringify(data, null, 2), 'utf8')
  await chmod(configPath, 0o600)
}

/** Update only a patch of fields and persist. */
export async function patch(p: Partial<GoofishConfig>): Promise<GoofishConfig> {
  const current = await load()
  const next: GoofishConfig = {
    command: p.command ?? current.command,
    args: p.args ?? current.args,
    env: { ...current.env, ...(p.env ?? {}) },
    readOnly: p.readOnly ?? current.readOnly,
    lastConnectedAt: current.lastConnectedAt,
  }
  await save(next)
  return next
}

/** Reset to defaults. */
export async function reset(): Promise<void> {
  await save({ command: DEFAULT_COMMAND, args: [], env: {}, readOnly: true })
}

/** Record that the MCP connection succeeded (for status display). */
export async function recordConnected(): Promise<void> {
  const current = await load()
  current.lastConnectedAt = Date.now()
  await save(current)
}

/** Mask secrets in env before exposing to the agent. */
function maskKey(key: string): string {
  return /secret|token|pass|key|auth/i.test(key) ? (key + ':****') : key
}

/** Validation + status view (no secrets exposed). */
export async function view(cfg: GoofishConfig): Promise<GoofishView> {
  return {
    configured: true,
    readOnly: cfg.readOnly !== false,
    command: cfg.command,
    args: cfg.args,
    envKeys: Object.keys(cfg.env).map(maskKey),
    connected: false,
    toolCount: 0,
    lastConnectedAt: cfg.lastConnectedAt ?? null,
    configPath,
    cookiePath,
    loginHint: `goofish auth login --qr (or export cookies.json) — plugin never reads the cookie itself`,
  }
}
