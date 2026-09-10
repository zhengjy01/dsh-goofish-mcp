# dsh-goofish-mcp

闲鱼 (Xianyu / Goofish) 只读数据监控 for DeepSeek Harness.

驱动 [goofish-cli](https://github.com/fancyboi999/goofish-cli) 的 MCP 服务器（stdio 子进程），把闲鱼只读数据能力封装为 `mcp__goofish__*` 工具。**写操作工具一律不注册**（只读边界，杜绝发布/下架/发消息/改登录态）。

## 能力

- `mcp__goofish__search_items` — 搜索闲鱼商品（真实返回）
- `mcp__goofish__item_get` / `item_view` — 商品详情
- `mcp__goofish__item_list` — 当前账号在售
- `mcp__goofish__message_list_chats` / `message_history` — 会话/消息历史
- `mcp__goofish__category_recommend` / `location_default` / `auth_status`

## 本插件不暴露（只读过滤）

`item_publish` / `item_delete` / `media_upload` / `message_send` / `auth_login` / `auth_reset_guard` / `message_watch` / `skills_install`

## 兼容性

要求 **DeepSeek Harness ≥ 0.1.5-rc.1**（已在包清单的 `dsh.engines.dsh` 中声明，DSH 插件市场据此显示兼容版本），并已在 **0.1.5-rc.1** 上实测通过。本构建包含 DSH 0.1.5 的适配：工具结果的严格校验契约（lossless-JSON 快照、`additionalProperties: false` 的 schema 校验、`output.render` 必须返回 `ContentBlock[]`），以及不依赖宿主 PATH 的可执行文件解析（launchd 托管的宿主 `PATH` 只有 `/usr/bin:/bin`）。

## 前置

1. 安装 goofish-cli：`uv tool install goofish-cli`（提供 `goofish-mcp`）
2. 登录一次（cookie/二维码）：`goofish auth login` 或 `goofish auth login --qr`
3. 确认：`goofish auth status` → `valid: true`

## 安装 / Install

```sh
# from npm (published package)
dsh plugin --profile web add dsh-goofish-mcp

# or local development
dsh plugin --profile web add link:/path/to/dsh-xianyu

# then restart dsh web to activate
```

## Agent 工具

- `goofish_status` — 连接/注册/只读状态
- `goofish_config` — 配置 stdio 命令/参数/只读开关
- `goofish_test` — 测试连接并列出只读工具
- `goofish_tools` — 列出只读工具

配置存 `~/.dsh/dsh-xianyu.json`（0600）；登录 cookie 由 CLI 管理，本插件不读。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm build   # tsdown -> lib/index.mjs (host only)
```
