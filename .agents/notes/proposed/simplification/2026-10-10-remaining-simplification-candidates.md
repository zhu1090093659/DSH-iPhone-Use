# Agent Note: 本轮清理保留的简化候选

Status: proposed

## Problem

2026-10-10 的清理轮次移除了死代码、重复清单与已失效的宿主通道，但有几类候选需要独立决策或
更大范围的重写，本轮**未实施**。它们在此登记，避免以后重新做一遍调查。

候选（按证据强度）：

1. **技能散文重复**：READY / 通道恢复流程分布在 6 个文件（`pua_foreground_unavailable` 出现在
   6 个文件、`recovery_phase` 在 5 个），两个技能各自的启动流程最长公共子串达 904 字符
   （约占较短文件 48%），且没有任何测试或门禁守着这些句子。
2. **`README.en.md` 的所有权**：中文 README 是事实来源，英文版按此策略只保留宿主无关的
   设备说明 + 指向中文版的链接；缺少明确契约时两份会持续漂移。
3. **`THIRD_PARTY_NOTICES.md` 的核对**：已随 widget 栈删除的依赖条目需要重审（哪些包仍在
   `tooling/` 与 DSH 包里真正发布），本轮只做删除，未做完整比对。
4. **`scripts/package.py` 的产物定位**：DSH 包由 `dsh/scripts/build.mjs` 产出，`package.py`
   仍产出 `dist/iphone-use-<版本>-source.zip`；两者是否都需要，取决于是否继续发布源码包。
5. **`tests/test_latency.py` 的 35 处传输断言**：多个测试各自手写
   `assertEqual([path for _, path, _ in client.actions()], [...])`，可抽成一个共享 oracle；
   但各处的期望序列并不完全相同，需要逐个核对（约 12 处是逐字重复）。
6. **`server/` 三处无宿主的兼容缝**：`installedApps` 读取分支、`parse_apple(verified_at=…)`
   参数、`_api_url` 接受但运行时不使用的 `/lookup` 路径——都只被自身测试覆盖。
7. **`WDA_SETTLE_SECONDS` 等环境开关**：有消费者但无文档、无 CI 使用；要么写进文档，
   要么删除（`WDA_SETTLE_SECONDS` 的默认 0 意味着整个 `cool_off` 分支只在测试里运行过）。

## Proposal

逐个候选单独决策，不打包实施；每个候选都有独立的验收条件：

1. 指定单一所有者（`iphone-use-setup` 拥有启动/恢复，`iphone-use` 只链接），并给共享句子
   加一条门禁（重复句子数量的上限断言），否则删掉的句子会再长回来。
2. 在 `README.en.md` 顶部写明"设备说明与 DSH 指向"的边界，或补齐翻译；二选一后由文档检查守。
3. 用 `tooling/package.json` 与 DSH tarball 的实际文件清单比对 `THIRD_PARTY_NOTICES.md`，
   删除不再发布的条目，补齐仍发布但缺失的（widget 依赖已随栈删除）。
4. 若不再发布源码包，删除 `package.py` 与 `SOURCE_DIRS`/`INSTALL_SCRIPTS` 分支；
   若仍发布，把它的产物与 DSH tarball 的关系写进 `dsh/docs/install.md`。
5. 仅对逐字重复的约 12 处抽共享 oracle；期望序列不同的保持内联。
6. 逐个判定"兼容缝"是否对应真实设备形态：`installedApps` 需要一台产出该字段的设备，
   `/lookup` 需要确认 `update_app_catalog.py` 之外无调用者。
7. 为每个环境开关决定文档化或删除；删除时同时删掉只覆盖该开关的测试。

## Alternatives considered

- **一次性全部实施**：否决。7 项里 3 项（技能散文、README.en、THIRD_PARTY_NOTICES）是产品/文档
  取舍，2 项需要真机或外部证据，混在一起会把"可机械验证"的部分拖成不可验收的大改。
- **只记录不实施**：本轮已按此处理，因为用户明确要求先完成清理。
- **给每项单独建记录**：与仓库规模不成比例；候选在同一决策面下（"还有哪些义务可以移除"），
  合并且按项写验收条件更易核对。

## Acceptance criteria

- 每项被实施或明确否决，并给出证据（搜索计数、测试、或实测输出）。
- 涉及行为的项（1、4、5、6、7）必须有对应测试或门禁；纯文档项（2、3）必须让文档检查通过。
- 实施后本记录被取代或更新，不留下与新事实冲突的正文。

## Risks

- 候选 1 的重叠部分是"技能独立可加载"的代价：`iphone-use-setup` 必须能在没有
  `iphone-use` 的会话里单独读懂，削减过头会让该技能失去自足性。
- 候选 7 的开关被外部用户通过环境变量使用时，删除是静默的行为变更；删除前应先确认
  没有文档或发布说明曾承诺它们。
- 候选 6 的"无生产者"结论基于本机设备与当前 Xcode；新机型或新 Xcode 可能重新产生这些形态。
