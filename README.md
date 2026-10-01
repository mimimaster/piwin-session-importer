# Session Importer for piwin

跨平台会话导入扩展（Session Importer），用于从 Claude Code、Cursor、Codex 和 OpenCode 导入历史对话到 piwin。

## 功能特性

- **多平台支持**：支持解析并导入 Claude Code (`~/.claude`)、Cursor (`~/.cursor`)、Codex (`~/.codex`) 和 OpenCode 的会话记录。
- **智能脱敏与清理**：自动移除 API Key / Token 等凭证，剥离提示词包装与中断标签。
- **桌面原生交互**：通过 `/import-session` 命令弹出交互式平台选择器与文件选择器。
- **会话悬浮看板**：导入后在输入框上方渲染会话进度挂件 (`setWidget`) 与状态指示 (`setStatus`)。
- **Agent 工具集成**：提供 `import_foreign_session` 工具，AI 可直接执行会话上下文分析。

## 安装与使用

在 piwin 桌面端「扩展市场 → piwin 扩展」搜索 **Session Importer** 并点击安装。

安装启用后：
1. 点击输入框「+」加号菜单的「扩展」选择 `/import-session`，或直接在输入框键入 `/import-session`。
2. 在弹出的交互式卡片中选择会话源平台或输入文件路径。
3. 确认导入轮次后，对话内容即可注入当前会话。
