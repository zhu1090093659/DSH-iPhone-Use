# Agent Notes

本目录保存值得维护者重访的决策：问题、真实备选、后果与验证方式。它记录"为什么这样做"，
不复制代码事实；机械修复、受既有决策约束的改动和一次性配置不在此登记。

## 路径契约

`{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`，日期取首次提案日期。

- 生命周期：`proposed`（未实施）、`implemented`（已交付）、`rejected`（已否决）、
  `archived`（低未来价值的已实施记录，冻结保留）。
- 类别：`feature`、`bug-fix`、`simplification`、`architecture`、`process`、`testing`。
- 按需要创建目录，不预建空树，不维护集中索引。

## 记录格式

首行 `# Agent Note: <title>`，空行，再一行 `Status: <status>`。正文以 `## Problem` 开篇。

- 提案记录（`proposed`）包含 `Proposal`、`Alternatives considered`、`Acceptance criteria`、`Risks`。
- 实施记录（`implemented`）包含 `Decision`、`Alternatives considered`、`Consequences`。
- 否决记录（`rejected`）说明被否决的方案与具体理由，便于以后同题复用证据。

只写实际成立的备选与证据，不编造历史依据；无法重建的部分明确写"缺失"。事实发生变化时
更新记录正文，不静默改写历史决策。

## 与代码和测试的分工

可机械检查的稳定约束交给脚本与测试，不靠文档背诵。记录只承载脚本无法表达的部分：
为什么选它、放弃了什么、什么条件下应当重访。
