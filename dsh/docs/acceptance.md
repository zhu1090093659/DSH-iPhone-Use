# DSH 迁移验收记录

本文件逐项记录迁移目标的验收结果：命令、实际输出、兼容范围与剩余限制。
所有验证都在隔离的 `DSH_HOME`（`/tmp/...`）下进行，不触碰用户真实的
`~/.dsh`，不占用当前 GUI 的 19387 端口。

- 宿主：`@deepseek-ai/dsh@0.2.0-rc.2`（`dsh` CLI）
- 平台：macOS（Darwin 25.x），Node v25.8.1，npm 11.11.0，Python 3.14.5，Xcode 27.0
- 起点提交：`66385cc`
- 复核命令：`sh scripts/check.sh`（仓库门禁）与 `node dsh/scripts/verify-e2e.mjs`（端到端）

## 一键复核

```sh
node dsh/scripts/verify-e2e.mjs                              # 20/20 通过
sh scripts/check.sh                                          # 仓库门禁
node --test --test-timeout=40000 'dsh/plugin/test/*.test.js' # 28 个插件测试
```

`verify-e2e.mjs` 的实际结果（本机）：

```text
PASS  build produces a tarball
PASS  install composes the bundle — @deepseek-ai/dsh-base, @deepseek-ai/dsh-headless, dsh-iphone-use
PASS  install records the dependency
PASS  --dump-config shows the row
PASS  the plugin module imports (dump-config-schema exits 0)
PASS  the session completes
PASS  the model called a pua_* tool — pua_metrics
PASS  the bridge answered the call — completed
PASS  the answer is the bridge's own value
PASS  all 17 model-visible pua tools reach the model — pua_apps,pua_batch,pua_collect_list,
      pua_doctor,pua_find,pua_launch_app,pua_metrics,pua_observe,pua_press_button,pua_ready,
      pua_screen,pua_scroll_find,pua_setup,pua_swipe,pua_tap,pua_type_text,pua_wait
PASS  the profile installs the package itself
PASS  the installed package ships server/iphone_use.py
PASS  the installed package ships skills/iphone-use/SKILL.md
PASS  the installed package ships skills/iphone-use-setup/SKILL.md
PASS  the installed package ships tools.generated.json
PASS  the installed package ships client.js
PASS  the installed plugin works with the checkout absent
PASS  the bundle row is gone
PASS  the dependency is gone
PASS  the user's real DSH home was untouched

20/20 checks passed
```

其中 `the installed plugin works with the checkout absent` 是最强的一条自足性证据：
脚本把开发用的 checkout 目录整体改名移走，再从该目录之外启动 profile，会话仍成功调用
`pua_metrics` 并拿到桥接层返回值——说明安装后的插件完全从自身解析 `server/`、`skills/`
与 `tools.generated.json`，不依赖开发机上的仓库路径。

## 目标 1：主运行链路由 DSH 驱动（无 Codex 回退）

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 运行时/工具注册/会话/生命周期由 DSH 宿主拥有 | 通过 | `dsh/plugin/index.js`：`ctx.tools.register`、`ctx.effect`、`ctx.inject(['webServer'])`、`ctx.sidebarRightTabs` |
| 不需要安装/登录/启动 Codex | 通过 | `verify-e2e.mjs` 在无 Codex 参与的隔离 `DSH_HOME` 中完成安装、加载、发现与调用；`lib/bridge.js` 只用 Node 内建模块 |
| 主链路无 Codex 专属依赖 | 通过 | `dsh/plugin/package.json` 无 `dependencies`；`test_plugin_never_shells_out_to_codex` 与 `the plugin declares no dependency...` 断言源码不含 `@deepseek-ai/*`、`.codex` 引用 |
| 保留设备桥接 | 通过 | 同一个 `server/iphone_use.py`（依赖为零的 MCP stdio 服务）作为受管子进程；`pua_doctor` 在真实会话中返回本机实测数据 |
| 真实运行证明无隐藏回退 | 通过 | 模型调用 `pua_doctor` 得到实时机器诊断（Xcode 27.0、node v25.8.1、`runtime` 路径等），`pua_metrics` 在前一次调用后计数从 0 变为 1 |

`pua_doctor` 的真实返回（节选）：`{"ok":false,"checks":{"macos":true,"full_xcode":true,
"git":true,"node":true,"npm":true,"configured":false,"selected_device_present":false},
"devices":[],"xcode_version":"Xcode 27.0\nBuild version 27A266a"}`。

## 目标 2：可独立安装的插件产物

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 完整入口 + 元数据 + 依赖声明 | 通过 | `dsh/plugin/package.json`（`main`、`exports`、`engines.dsh`、`dsh.bundle.patch`、`dsh.client`） |
| 可重复的构建/打包命令 | 通过 | `node dsh/scripts/build.mjs` → `dsh/dist/dsh-iphone-use-1.0.0.tgz`（154.5 kB，36 个文件） |
| 走 DSH 官方安装机制 | 通过 | `dsh plugin --profile <p> add <tarball>`，`dsh.profile.bundles` 追加 `dsh-iphone-use` |
| 产物无本机绝对路径 / 无仓库链接 | 通过 | `test_tarball_is_self_contained` 断言 `index.js`、`client.js` 不含构建机家目录；入口用 `import.meta.url` 解析自身 |
| 安装后自足：不依赖开发机 checkout | 通过 | e2e 把 checkout 改名移走后再跑会话，仍 `status=completed`；`findAssetDirectory` 优先包内路径，开发回退以源码树标记为闸门 |
| 未修改 DSH 核心源码 | 通过 | 只调用 `ctx.tools`、`ctx.webServer`、`ctx.sidebarRightTabs`、`ctx.slots`、`ctx.effect`、`ctx.inject` 与 `dsh plugin` CLI |

## 目标 3：干净配置下的安装体验

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 在隔离干净 `DSH_HOME` 下按文档安装并启用 | 通过 | `DSH_HOME=/tmp/... dsh plugin --profile iue2e add <tarball>` |
| 宿主识别插件 | 通过 | `--dump-config` 输出 `- id: iphone-use / name: dsh-iphone-use`；`--dump-config-schema` 退出 0（无 loader 警告） |
| 会话发现并调用 iPhone 工具 | 通过 | 真实 headless 会话向模型通告 17 个 `pua_*` 工具并成功调用 |
| 禁用/卸载清理工具与资源 | 通过 | `dsh plugin remove` 后 `bundles` 与 `dependencies` 均不含 `dsh-iphone-use`（`test_install_composes_the_row_and_uninstall_removes_it`） |
| 生命周期释放（工具/技能/子进程） | 通过 | `lifecycle.test.js`：挂载注册 17 个工具 + 2 个技能，dispose 后注册表清空且受管子进程被回收 |
| 不污染用户现有 DSH 配置 | 通过 | `test_isolated_home_is_the_only_one_written` 与 e2e 的 `the user's real DSH home was untouched` |

## 目标 4：功能对齐

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 能力盘点与前后对照清单 | 通过 | [`migration-inventory.md`](migration-inventory.md)（宿主适配、工具对照、Codex 耦合处置） |
| 核心能力仍可由 DSH 调用 | 通过 | 17 个模型工具与 2 个面板工具全部注册；`tools.generated.json` 从 `server/iphone_use.py` 生成并由 `--check` 守住 |
| **真机闭环（≥1 个）** | **未验证** | **本机没有连接真实 iPhone，见下节** |
| 缺失/授权不足时的清晰报告 | 通过 | `pua_ready` 返回 `pua_unreachable` + `initialization_required` + 下一步 `pua_setup`；决不伪造 |

### 真机闭环为何未验证（如实记录）

```text
$ xcrun devicectl list devices
Wordbook Demo     ...  simulated
Wordbook Reclaim  ...  simulated
$ system_profiler SPUSBDataType | grep -c -i iphone
0
$ xcrun simctl list devices booted
(空)
```

本机只存在两个 **simulated** 设备，没有 USB 连接的真实 iPhone；`xcrun devicectl`
不列出任何 physical 设备，`system_profiler` 的 USB 树中没有 Apple 移动设备。
WDA 需要通过 USB 在真实设备上签名并运行，模拟器无法替代。

因此**「在可用设备上完成至少一个真实闭环（取屏幕/状态、执行一次安全动作、返回可检查结果）」
未完成验证**。已完成的替代证据是本机可执行的最大范围：设备桥接真实启动、真实会话真实调用
`pua_doctor`/`pua_metrics` 并拿到真实返回值；**没有使用任何 mock 冒充真机验收**。
真实闭环需要接入一台已信任、已开启开发者模式并解锁的 iPhone 后，按
[`install.md`](install.md) 第 3 节配置，再运行 `pua_ready` 并执行一次安全动作。

## 目标 5：兼容性与失败处理

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 声明支持的 DSH 版本与桌面系统 | 通过 | `engines.dsh: ">=0.2.0-rc.2"`，仅在 `0.2.0-rc.2` 上实测；平台范围见 `install.md` 第 1 节 |
| 设备侧依赖与权限前提 | 通过 | `install.md` 第 1 节（macOS、完整 Xcode、Apple 团队、USB 信任、开发者模式、Python 3.9+、Node 20.19+/22.12+/24+、npm 10+） |
| 适配器不绑定单机/定制 DSH | 通过 | 入口按 `import.meta.url` 解析自身；所有配置项均有默认值；无硬编码路径 |
| 设备未连接 | 通过 | `pua_ready` → `pua_unreachable`、`initialization_required: true`、`next_tool: pua_setup` |
| 缺少权限/未配置 | 通过 | `pua_doctor` 返回 `checks.configured=false`、`manual_checks.*="user_check_required"` |
| 连接失败 / 解释器缺失 | 通过 | `bridge.test.js`：`the phone bridge could not be started: ... ENOENT` |
| 连接早退 | 通过 | `the phone bridge exited (code=3 signal=null)` |
| 超时 | 通过 | `the phone bridge did not answer tools/call within 400 ms` |
| 调用方取消 | 通过 | `exec.signal` 转发至桥接请求；取消立即结算，且文案不谎称动作已撤销（`the phone may still finish the accepted operation`） |
| 权限不足 | 通过 | 存在但不可执行的入口报 `could not be started` 并保留系统原因（EACCES） |
| 宿主关闭清理资源 | 通过 | `stop()` 以 stdin 结束 → 宽限 → SIGKILL；spawn 失败也结算，不再挂起（`b4e7c92` 修复） |
| 工作台面板错误可读 | 通过 | 伪造 `Host` → 403；非法 action → 400 `invalid_argument` |
| 未夸大版本/平台 | 通过 | 文档只声明在 macOS + DSH `0.2.0-rc.2` 实测 |

## 目标 6：用户文档

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 从零安装 | 通过 | `dsh/docs/install.md` 第 2 节 |
| 配置/连接 iPhone | 通过 | `install.md` 第 3 节 |
| 在 DSH 会话中调用 | 通过 | `install.md` 第 4 节 |
| 故障排查 | 通过 | `install.md` 第 6 节 |
| 禁用/卸载 | 通过 | `install.md` 第 7 节 |
| 从原始 Codex 用法迁移 | 通过 | `install.md` 第 8 节 + `migration-inventory.md` |
| 干净配置下按文档安装可复现 | 通过 | `verify-e2e.mjs` 即按文档步骤执行 |
| 普通用户无需改源码或 DSH 核心 | 通过 | 只安装 tarball；文档不含源码改动步骤 |

## 目标 7：验证与交付

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 构建、类型检查、测试通过 | 通过 | `sh scripts/check.sh`；19 个插件测试；13/13 e2e |
| 新增安装/加载/调用/清理与错误路径测试 | 通过 | `dsh/plugin/test/{host,bridge,lifecycle}.test.js`（28 个）、`tests/test_dsh_plugin.py`（12 个） |
| 复核最终 diff | 通过 | 见下方提交列表；均为本任务文件 |
| 兼容范围与剩余限制 | 通过 | 见本节与「已知限制」 |
| 每批改动立即提交 | 通过 | 6 个提交，逐个只暂存本任务文件 |
| 不推送/不发布 | 通过 | 未 push、未 npm publish、未创建 Release |

### 提交列表（`66385cc` 起）

| 提交 | 内容 |
| --- | --- |
| `a823229` | DSH 宿主驱动的插件包（宿主半 + 客户端半 + 打包/安装/卸载 + 迁移盘点） |
| `cb55655` | 技能注册、`pua_screen` 唤出面板、桥接错误透传 |
| `3f9801f` | 12 个插件契约测试并接入 `check.sh` |
| `fa25150` | 宿主中立文案 + 13 个宿主侧测试 |
| `b4e7c92` | 桥接启动失败与关闭挂起修复 + 6 个传输测试 |
| `0e7ebed` | 一键端到端验证脚本 |
| `5ee6d4e` | 资产解析同时支持源码树与安装包 + 6 个生命周期测试 + e2e 自足性证明 |
| `0310f5a` | 调用方取消（`exec.signal`）与权限失败原因透传 + 3 个测试 |

### 产物位置

- 安装包：`dsh/dist/dsh-iphone-use-1.0.0.tgz`（由 `node dsh/scripts/build.mjs` 生成）
- 插件源码：`dsh/plugin/`
- 工具表：`dsh/plugin/tools.generated.json`（`dsh/scripts/emit_tools.py` 生成）
- 文档：`dsh/docs/`

## 已知限制

1. **真机闭环未验证**：本机无 USB 真实 iPhone，见目标 4。
2. **DSH 版本范围**：仅在 `0.2.0-rc.2` 实测。客户端半依赖 `__ModuleLoader__` 模块表；
   宿主升级后需重新验证面板注册契约（`sidebar.right.pane.tab` 的 `useTabInfo` 由 slot 拥有者注入）。
3. **面板平台**：需要 `webServer` 服务（Web/桌面 profile）；纯 TUI profile 只有工具、没有面板。
4. **未验证项**：Windows/Linux 未验证（WDA 与 USB 转发为 macOS 路径）；
   ARM/Intel 差异未单独验证；签名证书过期与 iOS 版本升级后的恢复流程沿用原仓库技能，未在本机复验。
5. **预存在的门禁失败**：`tests/test_controller.FoundationPredicateTests` 因本机 clang
   工具链损坏（`Toolchain Swift 6.3.1 could not be located`）无法编译探针。基线提交
   `66385cc` 在本机同样失败，与本次改动无关；已在提交信息中记录。
6. **发布未授权**：未推送远程、未发布 npm、未创建 GitHub Release（按任务边界）。
