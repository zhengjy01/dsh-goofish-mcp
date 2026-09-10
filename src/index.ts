/**
 * dsh-xianyu — 闲鱼 read-only MCP monitoring for DeepSeek Harness. Host half.
 *
 * Mounts a supervised stdio connection to the goofish-cli MCP server
 * (read-only tools registered as mcp__goofish__*, write tools filtered out)
 * and the agent tools goofish_status / goofish_config / goofish_test /
 * goofish_tools. Login lives with the CLI (~/.goofish-cli/cookies.json);
 * config is stored in ~/.dsh/dsh-xianyu.json.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import * as storeMod from './store.ts'
import { createSupervisor, READ_ONLY_TOOLS, type McpSupervisor } from './mcp.ts'

/** Stable cordis plugin name. */
export const name = 'goofish-mcp'

/** Services required before the plugin surfaces can mount. */
export const inject = ['tools', 'systemPrompt']

const SECTION_ORDER = 212

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const GOOFISH_GUIDANCE =
  '本机已安装 dsh-xianyu 插件（闲鱼 read-only MCP 监控）：驱动 goofish-cli MCP 服务器，把闲鱼只读数据能力封装为 mcp__goofish__* 工具（search_items 搜索、item_get/item_view 商品详情、item_list 在售商品、message_list_chats/message_history 会话历史、category_recommend 类目识别、location_default 默认地址、auth_status 登录态）。' +
  '工具：goofish_status（状态）、goofish_config（配置 stdio 命令/参数/只读开关）、goofish_test（测试连接并列出工具）、goofish_tools（列出工具）。' +
  '安全边界：本插件只暴露只读工具，发布/下架/发消息/auth_login 等写操作工具一律不注册；登录态由用户在终端用 goofish auth login 完成。' +
  '用户提到「闲鱼 / 咸鱼 / goofish / 二手监控 / 查闲鱼」时即指本插件，请据此协作。'

/** Plugin config, read from the composition row. */
export interface Config {
  announceToAgent?: boolean
  enabled?: boolean
  readOnly?: boolean
  command?: string
  args?: string[]
}

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

export interface ToolContext {
  store: typeof storeMod
  supervisor: McpSupervisor
}

/** Status tool. */
export function goofishStatusTool(ctx: ToolContext) {
  return defineTool({
    name: 'goofish_status',
    description: '查看 dsh-xianyu 插件状态：是否已连接 MCP、已注册的只读闲鱼工具数量、是否开启只读过滤、stdio 命令、最近连接时间与 cookie 路径。不会泄露任何密钥。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          readOnly: { type: 'boolean' },
          connected: { type: 'boolean' },
          toolCount: { type: 'number' },
          command: { type: 'string' },
          lastConnectedAt: { type: 'number' },
          cookiePath: { type: 'string' },
        },
      },
      render: (_args: unknown, value: Record<string, unknown>) => text(String(value.message ?? '')),
    },
    async execute() {
      try {
        const cfg = await ctx.store.load()
        const view = await ctx.store.view(cfg)
        const parts = [
          '闲鱼只读监控：' + (ctx.supervisor.isConnected() ? '已连接' : '未连接'),
          '注册工具：' + ctx.supervisor.toolCount() + ' 个（mcp__goofish__*）',
          '只读模式：' + (view.readOnly ? '开（自动过滤写操作工具）' : '关（风险：会暴露写工具）'),
          'stdio 命令：' + view.command + (view.args.length ? ' ' + view.args.join(' ') : ''),
          '登录 cookie：' + view.cookiePath + (view.lastConnectedAt !== null ? '\n最近连接：' + new Date(view.lastConnectedAt).toLocaleString() : ''),
        ]
        // DSH 0.1.5+ rejects a tool result containing an explicit `undefined`
        // ("value is not lossless JSON"), so the optional timestamp is omitted
        // rather than set to undefined.
        return {
          ok: true,
          message: parts.join('\n'),
          readOnly: view.readOnly,
          connected: ctx.supervisor.isConnected(),
          toolCount: ctx.supervisor.toolCount(),
          command: view.command,
          cookiePath: view.cookiePath,
          ...(view.lastConnectedAt === null || view.lastConnectedAt === undefined
            ? {}
            : { lastConnectedAt: view.lastConnectedAt }),
        }
      } catch (error) {
        return { ok: false, message: '读取状态失败: ' + String(error instanceof Error ? error.message : error) }
      }
    },
  })
}

/** Config tool: set stdio command/args/env or the read-only toggle. */
export function goofishConfigTool(ctx: ToolContext) {
  return defineTool({
    name: 'goofish_config',
    description: '配置 dsh-xianyu：command（stdio 命令，默认 goofish-mcp）、args（命令行参数数组）、env（环境变量对象）、readOnly（是否只注册只读工具，默认 true）、reset（恢复默认）。配置持久化到 ~/.dsh/dsh-xianyu.json（0600）。',
    parameters: {
      command: { type: 'string', description: 'stdio 命令（默认 goofish-mcp）' },
      args: { type: 'array', items: { type: 'string' }, description: '命令行参数' },
      env: { type: 'object', additionalProperties: false, description: '环境变量（可选）' },
      readOnly: { type: 'boolean', description: '是否只注册只读工具（默认 true）' },
      reset: { type: 'boolean', description: '恢复默认配置' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          readOnly: { type: 'boolean' },
          command: { type: 'string' },
          configPath: { type: 'string' },
        },
      },
      render: (_args: unknown, value: Record<string, unknown>) => text(String(value.message ?? '')),
    },
    async execute(args: Record<string, unknown>) {
      try {
        if (args !== undefined && args.reset === true) {
          await ctx.store.reset()
          return { ok: true, message: '已恢复默认配置。', readOnly: true, command: 'goofish-mcp', configPath: ctx.store.configPath }
        }
        const patch: Partial<storeMod.GoofishConfig> = {}
        if (typeof args?.command === 'string') patch.command = args.command
        if (Array.isArray(args?.args)) patch.args = args.args.map(String)
        if (args?.env && typeof args.env === 'object') patch.env = args.env as Record<string, string>
        if (typeof args?.readOnly === 'boolean') patch.readOnly = args.readOnly
        const cfg = await ctx.store.patch(patch)
        // A read-only toggle changes which tools register; request a reconnect.
        void ctx.supervisor.restart().catch(() => {})
        return {
          ok: true,
          message: '闲鱼插件配置已保存（命令 ' + cfg.command + '，只读 ' + (cfg.readOnly ? '开' : '关') + '）。已请求重连。',
          readOnly: cfg.readOnly,
          command: cfg.command,
          configPath: ctx.store.configPath,
        }
      } catch (error) {
        return { ok: false, message: '配置失败: ' + String(error instanceof Error ? error.message : error) }
      }
    },
  })
}

/** Test tool: probe the MCP connection and list tools. */
export function goofishTestTool(ctx: ToolContext) {
  return defineTool({
    name: 'goofish_test',
    description: '测试 dsh-xianyu 闲鱼 MCP 连接：确认连接有效并列出当前注册的只读工具名（mcp__goofish__*）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          connected: { type: 'boolean' },
          toolCount: { type: 'number' },
          tools: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args: unknown, value: Record<string, unknown>) => text(String(value.message ?? '')),
    },
    async execute() {
      try {
        const connected = ctx.supervisor.isConnected()
        const tools = connected ? await ctx.supervisor.listTools() : []
        return {
          ok: connected,
          message: connected
            ? `已连接闲鱼 MCP，注册 ${tools.length} 个只读工具：\n${tools.map((t) => 'mcp__goofish__' + t).join('\n')}`
            : '闲鱼 MCP 未连接（请确认 goofish-cli 已安装、已登录，且 mcp 子进程可启动）。',
          connected,
          toolCount: tools.length,
          tools,
        }
      } catch (error) {
        return { ok: false, message: '测试失败: ' + String(error instanceof Error ? error.message : error), connected: false, toolCount: 0, tools: [] }
      }
    },
  })
}

/** Tools tool: list the MCP server's (filtered) tools. */
export function goofishToolsTool(ctx: ToolContext) {
  return defineTool({
    name: 'goofish_tools',
    description: '列出 dsh-xianyu 闲鱼 MCP 当前注册的只读工具名（mcp__goofish__* 的后缀）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          tools: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args: unknown, value: Record<string, unknown>) => text(String(value.message ?? '')),
    },
    async execute() {
      try {
        if (!ctx.supervisor.isConnected()) return { ok: false, message: '闲鱼 MCP 未连接。', tools: [] }
        const tools = await ctx.supervisor.listTools()
        return { ok: true, message: '闲鱼只读工具（' + tools.length + ' 个）：\n' + tools.join('\n'), tools }
      } catch (error) {
        return { ok: false, message: '列工具失败: ' + String(error instanceof Error ? error.message : error), tools: [] }
      }
    },
  })
}

export function buildTools(ctx: ToolContext) {
  return [
    goofishStatusTool(ctx),
    goofishConfigTool(ctx),
    goofishTestTool(ctx),
    goofishToolsTool(ctx),
  ]
}

/**
 * Mount the goofish MCP tools + supervised connection + announcement.
 */
export function apply(ctx: Context, config?: Config): void {
  const announceToAgent = config?.announceToAgent !== false
  const enabled = config?.enabled !== false
  const store = storeMod
  const supervisor = createSupervisor(ctx, store)
  const context: ToolContext = { store, supervisor }

  let disposeTools: (() => void) | undefined
  let disposeSection: (() => void) | undefined

  const sync = (): void => {
    if (disposeTools !== undefined) { disposeTools(); disposeTools = undefined }
    if (disposeSection !== undefined) { disposeSection(); disposeSection = undefined }
    if (!enabled) return
    disposeTools = ctx.effect(
      () => {
        const disposers = buildTools(context).map((tool) => ctx.tools.register(tool))
        return () => { for (const dispose of disposers) dispose() }
      },
      'dsh-xianyu: tools',
    )
    if (announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-xianyu',
        order: SECTION_ORDER,
        text: GOOFISH_GUIDANCE,
      })
    }
  }

  sync()

  void (async () => {
    if (!enabled) return
    void supervisor.start().catch(() => {})
  })()

  ctx.effect(() => {
    return () => { void supervisor.dispose() }
  }, 'dsh-xianyu: connection')
}

export { createSupervisor, buildServerParams, publicToolName, READ_ONLY_TOOLS, type McpSupervisor } from './mcp.ts'
export { configPath, cookiePath, type GoofishConfig, type GoofishView } from './store.ts'
export { defineTool }
