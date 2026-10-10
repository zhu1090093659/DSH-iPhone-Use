# iPhone Use: Codex 到 DSH 迁移对照清单（历史记录）

本文件是迁移的基线盘点与验收对照表：左列是迁移前由 Codex 驱动的能力，右列是迁移后由
DSH 宿主驱动的对应实现与验证方式。

**Codex 宿主支持已于 2026-10-10 退休**，本表仅作历史对照：左列描述的 Codex 插件清单、
安装命令与 MCP Apps widget 均已从仓库删除，当前唯一宿主是 DSH。理由与后果见
[`.agents/notes/implemented/architecture/2026-10-10-dsh-only-host-and-widget-retirement.md`](../../.agents/notes/implemented/architecture/2026-10-10-dsh-only-host-and-widget-retirement.md)。

- 迁移前宿主：Codex 桌面端 / CLI（`codex plugin marketplace add` + `codex plugin add` + `codex mcp add`）
- 迁移后宿主：DeepSeek Harness（`@deepseek-ai/dsh`），插件通过 `dsh.profile.bundles` + bundle `cordis.patch.yml` 挂载
- 设备桥接层保持不变：Python + WebDriverAgent + `appium-ios-device` USB 转发

## 1. 宿主适配对照

| 关注点 | 迁移前（Codex） | 迁移后（DSH） | 验证 |
| --- | --- | --- | --- |
| 插件元数据 | `plugin.json` + `.codex-plugin/plugin.json`（agent-plugins.org schema，`extensions.com.openai.interface`） | `dsh/plugin/package.json` 的 `dsh.bundle.patch` + `dsh.client` | `dsh --profile <p> --dump-config` 显示插入行 |
| 安装机制 | `codex plugin marketplace add` / `codex plugin add` | `dsh plugin --profile <p> add <spec>`（官方插件管理器） | 干净 `DSH_HOME` 下安装后 `package.json` 的 `dsh.profile.bundles` 含 `dsh-iphone-use` |
| 工具注册 | MCP stdio 服务，Codex 侧命名为 `pua_*` | 宿主插件在 `ctx.tools` 注册同名 `pua_*` 工具 | `--dump-config-schema` 退出 0；会话工具表含 `pua_*` |
| 工具调用 | Codex MCP 客户端 | 插件内置 MCP stdio 客户端（`node:child_process` + JSON-RPC） | mock LLM 会话中 `tool_result status=completed` |
| 生命周期 | Codex 管理 MCP 子进程 | 插件 `ctx.effect` 管理 Python 子进程；dispose 时终止并注销工具与路由 | 卸载后工具消失、子进程退出 |
| 会话/面板 | Codex 侧边栏 widget（MCP Apps `ui://` + `openai/ui`） | DSH 右侧栏 tab（`ctx.sidebarRightTabs` + `ctx.slots`） | 页面加载后 tab 可见并显示画面 |
| 图片回传 | MCP `content[{type:image}]` + `openai/widgetSessionId` | 工具结果给出已落盘 PNG 的路径，模型用既有 `read_image` 查看 | 工具结果含 `image_saved_to` |
| 技能 | `skills/` 由 Codex 插件加载 | 同一 `skills/` 由 `@deepseek-ai/dsh-skill-filesystem` 从插件目录发现 | 会话技能目录可见 `iphone-use` |

## 2. 工具能力对照（迁移前后）

模型可见工具共 17 个；`pua_screen_frame`、`pua_screen_action` 为面板专用，不暴露给模型。

| 工具 | 能力 | 迁移后状态 |
| --- | --- | --- |
| `pua_doctor` | 本机 Xcode / USB / 签名 / 服务诊断，只读 | 保持（已实测通过） |
| `pua_setup` | 设备配置、后台安装/启动、状态查询 | 保持 |
| `pua_ready` | 会话就绪与解锁/会话校验 | 保持 |
| `pua_observe` | 控件树 / 截图 / 视口 | 保持 |
| `pua_find` | 选择器查询 | 保持 |
| `pua_tap` | 控件或坐标点击 | 保持 |
| `pua_swipe` | 单次滑动手势 | 保持 |
| `pua_press_button` | Home / 音量键 | 保持 |
| `pua_launch_app` | 按 bundle id 启动 | 保持 |
| `pua_type_text` | Unicode 输入与长文本续传 | 保持 |
| `pua_wait` | 有界目标等待 | 保持 |
| `pua_batch` | 组合动作 | 保持 |
| `pua_scroll_find` | 滚动查找 | 保持 |
| `pua_collect_list` | 有界列表采集 | 保持 |
| `pua_apps` | bundle id 解析 | 保持 |
| `pua_metrics` | 本进程耗时统计 | 保持 |
| `pua_screen` | 打开/暂停/恢复手机画面 | 语义改为「DSH 右侧栏面板」 |
| `pua_screen_frame` | 面板轮询帧（仅面板） | 仅供面板；由宿主插件经 `/iphone-use/frame` 调用 |
| `pua_screen_action` | 面板工具栏（刷新/主屏/截图） | 仅供面板；由宿主插件经 `/iphone-use/action` 调用 |

参数 schema 与返回值语义不变：`dsh/plugin/tools.generated.json` 由
`dsh/scripts/emit_tools.py` 从 `server/iphone_use.py` 生成，只做一次关键字投影
（内联 `$ref`、去掉 DSH 子集不接受的区间关键字），运行时校验仍由桥接层的
`SCHEMAS` 负责。

## 3. Codex 专属耦合与处置

| 位置 | Codex 专属内容 | 处置 |
| --- | --- | --- |
| `plugin.json` / `.codex-plugin/` | `extensions.com.openai.interface`、agent-plugins.org schema | 已删除（2026-10-10 退休 Codex 宿主） |
| `mcp.json` | `${PLUGIN_ROOT}` 占位由 Codex 展开 | 已删除；宿主插件用 `import.meta.url` 解析自身路径 |
| `scripts/install.sh` | `codex plugin marketplace add` / `codex mcp add` | 已删除；安装改用 `dsh/scripts/install.mjs` |
| `scripts/register_mcp.py` | 写 `~/.codex/config.toml` | 已删除 |
| `server/iphone_use.py` 的 `openai/ui`、`ui://` | MCP Apps 面板协议 | 已删除（含 `resources/*` 与 widget 栈）；面板走 `ctx.sidebarRightTabs` |
| `server/iphone_use.py` 的 `functions.exec` / `view_image` / `request_user_input_async` 文案 | Codex 工具名 | DSH 侧由职业技能文案与插件描述引导到 `run_code` / `read_image` |
| `server/analytics.py` | PostHog 匿名统计 | 保持，`IPHONE_USE_ANALYTICS=0` 可关闭；DSH 侧不新增埋点 |

主运行链路不含 Codex：DSH 侧的桥接子进程、工具注册、面板路由与生命周期全部由
`dsh/plugin/index.js` 管理，没有任何路径回退到 Codex。

## 4. 交付物

1. `dsh/plugin/`：可独立安装的 DSH 插件包（`package.json` 声明 `dsh.bundle.patch`
   与 `dsh.client`；`cordis.patch.yml` 插入宿主行）。
2. `dsh/plugin/tools.generated.json` + `dsh/scripts/emit_tools.py`：工具表投影及其一致性检查。
3. `dsh/scripts/build.mjs`：可重复打包，产出 `dsh/dist/dsh-iphone-use-<版本>.tgz`。
4. `dsh/scripts/install.mjs` / `uninstall.mjs`：干净的安装/卸载路径，不修改 DSH 源码。
5. `dsh/docs/install.md`：从零安装、配置设备、会话内调用、故障排查、卸载、从 Codex 迁移。
6. `dsh/docs/acceptance.md`：逐项验收记录（命令、实际结果、兼容范围、剩余限制）。
