# Agent Note: DSH 是唯一宿主，Codex 通道与 MCP Apps widget 一并退休

Status: implemented

## Problem

插件同时维护两个宿主通道：Codex 插件面（`plugin.json`、`.codex-plugin/plugin.json`、
`mcp.json` + `.mcp.json`、`scripts/install.sh`、`scripts/register_mcp.py`、
`.agents/plugins/marketplace.json`）与 DSH 插件包（`dsh/plugin/`）。两条通道共用
`server/` 与 `skills/`，但注册、安装、面板各自维护一份，且 Codex 侧的实时画面由
MCP Apps widget（`ui/` → `assets/phone-screen.html`）实现，DSH 侧由
`dsh/plugin/client.js` 的右侧栏面板实现。

维护代价与风险同时存在：

- 三份注册清单承载同一份 interface 数据，`scripts/package.py` 用断言维持它们相等。
- 实测 Codex 0.160.1 只读**根目录** `mcp.json`；`.codex-plugin/plugin.json` 里声明的
  `./.mcp.json` 被忽略，且该分支**不展开** `\${PLUGIN_ROOT}`，注册出的是坏路径。
- widget 栈（`ui/`、547 KB 生成物、widget 测试、CI 重建与 diff、`@modelcontextprotocol/ext-apps`）
  在 DSH 里没有可达消费者：`dsh/plugin` 不调用 MCP resources，运行中的 DSH 宿主
  `app.asar` 对 `mcp-app`/`ui://`/`openai/ui`/`text/html;profile` 命中数均为 0
  （阳性对照 `sidebarRightTabs`=35、`__ModuleLoader__`=88）。
- DSH 打包长期漏装该资源：`dsh/scripts/build.mjs` 把 `phone-screen.html` 放进 `EXCLUDE`，
  tarball 里 `package/assets/` 只有 `icon.svg`。

## Decision

用户确认 Codex 通道已退休，DSH 为唯一宿主。据此：

1. 删除 Codex 插件面：根 `plugin.json`、`.codex-plugin/`、`mcp.json`、`.agents/plugins/marketplace.json`、
   `scripts/install.sh`、`scripts/register_mcp.py`、`tests/test_registration.py`。
2. 删除 MCP Apps widget 栈：`ui/`、`assets/phone-screen.html`、`scripts/check_screen_ui.py`、
   CI 的 ui 步骤、`dsh/scripts/build.mjs` 的 `assets` 条目。
3. 删除桥接层的资源面：`SCREEN_URI`、`SCREEN_META`、`SCREEN_SESSION_ID`、
   `resources/list` 与 `resources/read` 分支、`ui` 元数据；**保留**
   `pua_screen_frame`/`pua_screen_action`，DSH 面板仍通过 `/iphone-use/frame` 与
   `/iphone-use/action` 调用它们。
4. 版本来源改为 `dsh/plugin/package.json`，工具表仍由 `dsh/scripts/emit_tools.py`
   从 `server/iphone_use.py` 生成。

保留的设备层不变：`server/` 的 WDA 通信、USB 转发、`tooling/`、`skills/` 与全部
`pua_*` 工具语义。

## Alternatives considered

- **合并两份 MCP 清单（保留 Codex）**：先按此实施并实测通过（Codex 只读根 `mcp.json`，
  合并后注册路径绝对且展开）。用户随后确认通道已退休，合并方案被更大的删除取代。
- **保留 widget 作为 Codex 的实时画面**：Codex 二进制确实支持 MCP Apps（`McpAppUi`×11、
  `resourceUri`×16），所以 widget 不是坏的，而是随宿主一起失去消费者。保留它意味着
  长期维护一个本机无宿主的构建产物。
- **只删 widget 的 DSH 打包缺口**：曾作为最小改动的推荐项提出（让 tarball 真正带上
  `phone-screen.html`），实测发现 DSH 从不调用 resources，补齐只是把一个无人读的文件
  装进包，不构成能力恢复。

## Consequences

- 维护面显著缩小：少一套安装/注册链路、一套 UI 构建链、一份 3 500 行的 widget 源码与
  1 833 行 lockfile、一个 npm 依赖。
- 失去的能力：Codex 宿主下的侧边栏实时画面与 `.codex-plugin` 清单约定；如需恢复，
  必须同时恢复宿主通道与 widget 构建。
- 包结构变化：DSH tarball 不再包含 `assets/`；`dsh/plugin/package.json` 的 `files` 同步移除该条目。
- **遗留**：`assets/iphone-use-demo.png` 仍被两份 README 引用，画面是 Codex 宿主，
  与当前产品表面不符，需重拍或替换为 DSH 面板截图。
- 验证：`sh scripts/check.sh` 覆盖生成表一致性、DSH 打包、31 个插件测试与 Python 套件；
  `python3 scripts/package.py --validate-only` 校验技能、工具数与版本一致。
