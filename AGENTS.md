# AGENTS

## 决策记录

值得维护者重访的决策（架构、契约、流程、测试策略）记录在 [`.agents/notes/`](.agents/notes/README.md)。
路径为 `{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`；写记录前先核对是否取代已有决定。

- 产生或改变行为契约、架构、风险边界、流程或测试策略时新增记录。
- 已有决策下的机械修复不需要新记录；必要时更新拥有该决策的现有记录。
- 记录写"为什么"与验证方式；可机械检查的约束放进 `scripts/check.sh` 或测试，不写进笔记。
