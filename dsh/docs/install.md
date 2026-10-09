# iPhone Use for DeepSeek Harness

让 DSH 通过 USB 操作真实 iPhone。安装本插件后，DSH 会话可以从模型直接调用
`pua_*` 工具打开 App、读取页面、点击、滑动、输入中文，并在右侧栏看到手机实时画面。

本插件是独立可安装包：不依赖 Codex，也不修改 DSH 源码。设备能力由同一个
Python 桥接层提供，使用 [WebDriverAgent](https://github.com/appium/WebDriverAgent)
与 USB 通信。

## 1. 环境要求

| 依赖 | 用途 | 说明 |
| --- | --- | --- |
| macOS | 宿主平台 | 目前仅在 macOS 上验证；其他平台未验证 |
| DSH `>=0.2.0-rc.2` | 宿主 | 已验证版本 `0.2.0-rc.2` |
| Node.js `20.19+` / `22.12+` / `24+` | 宿主插件与 USB 转发 | `node --version` 自查 |
| Python 3.9+ | 设备桥接服务 | 只用标准库；`python3` 需在 PATH 上 |
| 完整 Xcode（已首次启动） | 编译、签名、部署 WDA | 仅 Command Line Tools 不够 |
| Apple 账号与开发团队 | 签名手机端 WDA Runner | 需在 Xcode 中可用 |
| USB 连接的真实 iPhone | 被操作设备 | 需信任此 Mac 并开启开发者模式 |
| npm 10+ | 安装 WDA 转发依赖 | 桥接层按需 `npm ci` |

免越狱，无需单独启动 Appium Server。WDA 固定使用已验证的 16.14.0 提交。

## 2. 安装

在本仓库根目录执行：

```sh
node dsh/scripts/install.mjs --profile <你的 profile 名>
```

脚本会：

1. 用 `python3 dsh/scripts/emit_tools.py --check` 验证工具表与设备桥接一致；
2. 打包出 `dsh/dist/dsh-iphone-use-<版本>.tgz`；
3. 用官方机制 `dsh plugin --profile <profile> add <tarball>` 安装。

**注意** `desktop` profile 由 Electron 应用独占，命令行无法写入。若你使用
DSH 桌面应用，请在应用的插件页面安装同一条 tarball；若你用命令行启动
profile，任选一个 CLI 管理的 profile 名即可。

安装完成后重启该 profile（或按 profile 的 HMR 配置重载）。

### 从源码目录安装（不打包）

```sh
node dsh/scripts/install.mjs --profile <profile> --from "$(pwd)/dsh/dist/dsh-iphone-use"
```

先运行 `node dsh/scripts/build.mjs --stage` 生成未打包目录。

### 隔离验证（不污染现有 DSH 配置）

```sh
export DSH_HOME=/tmp/dsh-iphone-use-verify
node dsh/scripts/install.mjs --profile iuverify --dsh-home "$DSH_HOME"
DSH_HOME="$DSH_HOME" dsh plugin --profile iuverify list
```

## 3. 连接 iPhone

1. 用 USB 连接 iPhone，在手机上选择「信任此电脑」。
2. 按系统要求开启「开发者模式」并重启手机。
3. 在 Xcode 中登录自己的 Apple 账号，并确认有一个可用的开发团队。
4. 让 DSH 会话完成首次 WDA 安装：

   > 用 iphone-use-setup 技能帮我配置 USB 连接的 iPhone，安装并启动 WDA，
   > 验证 READY，然后打开手机屏幕。

首次配置会获取固定版本 WDA、下载依赖、签名、构建并启动 Runner，需要几分钟。
已完成配置的设备会复用配置和构建，日常任务无需重装。

以 `pua_ready` 返回 `ready=true` 为准，再开始手机任务。

## 4. 在 DSH 会话中调用

新会话里，工具会以 `pua_*` 出现在模型工具表中。示例：

```text
先调用 pua_ready 确认手机可用，然后打开备忘录新建一条草稿，输入下面这段中文，
核对文字后保留（不要提交）。
```

右侧栏的「手机屏幕」页显示实时画面，并带刷新 / 主屏幕 / 截图三个按钮。
点击页面里的按钮是用户自己的操作，不属于模型工具调用。

## 5. 配置

插件行的配置写在 profile 的 `cordis.patch.yml` 中。最常用的两项：

```yaml
- id: iphone-use
  config:
    # 状态目录（存放签名配置、构建与运行数据）
    env:
      IPHONE_USE_STATE_DIR: /Users/me/.local/share/iphone-use
      # 指定本机 WDA 地址，默认 http://127.0.0.1:18100
      WDA_URL: http://127.0.0.1:18100
```

其余字段见插件包内的 `cordis.patch.yml` 注释。所有字段都有安全默认值，
通常无需修改。

## 6. 故障排查

| 现象 | 处理 |
| --- | --- |
| 会话里没有 `pua_*` 工具 | 确认 profile 的 `dsh.profile.bundles` 含 `dsh-iphone-use`；重启 profile；查看启动日志的 loader 警告 |
| 工具报 `bridge_unavailable` | 检查 `python3` 是否在 PATH、`node` 版本是否满足；`dsh --profile <p> --dump-config-schema` 应退出 0 |
| `pua_ready` 返回 `not_ready` | 按会话提示走 `pua_setup` 启动流程，见 `iphone-use-setup` 技能 |
| 手机未解锁 / 锁屏 | 由用户解锁；预览会自动暂停，解锁后重试 `pua_ready` |
| USB 端口被占用 | 复用已有的健康 WDA，或换 `local_port`；不要杀无关进程 |
| 右侧栏没有画面 | 确认配置 `panel: true`、宿主是 Web/桌面 profile（Web 服务存在）；TUI profile 只有工具没有面板 |

## 7. 卸载

```sh
node dsh/scripts/uninstall.mjs --profile <profile>
```

这会经官方机制移除插件，工具、面板路由与桥接子进程一并释放。状态目录
（`~/.local/share/iphone-use`）不会被删除，便于以后重装复用签名与构建。

## 8. 从 Codex 迁移

本仓库同时保留 Codex 插件（`plugin.json`、`.codex-plugin/`、`mcp.json`）供原有
用法继续工作。迁移到 DSH 时：

- 新增的是 `dsh/` 下的 DSH 插件包，设备桥接层（`server/`）与技能（`skills/`）是
  同一份代码，不需要复制或改写。
- 安装方式从 `codex plugin add` 换成 `dsh plugin --profile <p> add`。
- 工具名、参数与返回值语义保持不变，原有的提示词与技能说明可以继续使用。
- 面板从 Codex 的侧栏 widget 换成 DSH 右侧栏的「手机屏幕」页。

对照清单见 [`migration-inventory.md`](migration-inventory.md)。
