# @goodandready/dsh-session-control

[English](../README.md) | [Русский](README.ru.md) | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/@goodandready/dsh-session-control.svg?style=flat-square)](https://www.npmjs.com/package/@goodandready/dsh-session-control)
[![npm downloads](https://img.shields.io/npm/dm/@goodandready/dsh-session-control.svg?style=flat-square)](https://www.npmjs.com/package/@goodandready/dsh-session-control)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![DeepSeek Harness](https://img.shields.io/badge/DSH-Plugin-blue.svg?style=flat-square)](https://goodandready.app)

**DeepSeek Harness** 侧边栏高级会话控制插件：置顶关键对话、带上下文匹配摘要的高级搜索、只读归档记录查看器、自动隐藏空白无用会话及多选批量操作。

---

## 插件对侧边栏的改造

本插件**替换了侧边栏的主体内容**——即工作区与会话列表部分。侧边栏的其他原生部分完全保持原样：品牌标识、新建会话按钮、底部状态栏以及设置导航入口均不受影响。

替换是架构上的必然要求：Harness 核心将 `sidebar.workspaces` 插槽声明为 `kind: "single"`，不允许注册多个并列组件，且侧边栏主体没有其他扩展插槽。

---

## 功能对比：原生侧边栏 vs dsh-session-control

| 功能特性 | 原生侧边栏 | `dsh-session-control` |
|---|---|---|
| **会话置顶 (Pin)** | ❌ 无 | ✅ 顶部全局置顶区，统一管理 |
| **归档视图 (Archive)** | ❌ 完全不可见 | ✅ 独立归档分区，按时间段折叠聚合 |
| **阅读归档会话** | ❌ 无法打开 | ✅ 只读完整会话转录记录弹窗 |
| **内容搜索结果** | ⚠️ 仅显示标题 | ✅ 标题 + 匹配内容上下文摘要预览 |
| **空白会话** | ⚠️ 与活跃会话混杂 | ✅ 自动隐藏无消息会话（当前会话除外） |
| **批量操作** | ❌ 无 | ✅ 复选框多选及 Shift+Click 范围批量操作 |
| **可逆隐藏** | ❌ 仅支持不可逆归档 | ✅ 一键可逆隐藏与恢复 |
| **活跃运行指示** | ❌ 无指示 | ✅ 实时运行脉冲状态圆点 |
| **就地快速重命名** | ⚠️ 弹窗修改 | ✅ 双击标题或按 F2 直接在行内重命名 |
| **跨文件夹分组** | ❌ 无法实现（归属由工作目录推导） | ✅ 独立标签，不受文件夹限制 |
| **会话名称** | ⚠️ 未命名会话一律显示项目目录名 | ✅ 取自你在该会话中的第一条消息 |
| **键盘导航** | ❌ 无 | ✅ `Ctrl+K` 快速跳转，活跃与归档会话通搜 |
| **导出内容** | ❌ 无法带走 | ✅ 复制或保存为 Markdown |

> 原生 Harness 核心功能（工作区目录、深度会话搜索、会话分支等）完全保留：插件复用并强化了核心能力，而非重复造轮子。

---

## 安装方法

通过 `dsh` CLI 为 web profile 安装：

```bash
dsh plugin --profile web add @goodandready/dsh-session-control
```

重启 DeepSeek Harness web profile 以应用 bundle patch。

---

## 恢复原生侧边栏

随时可以通过卸载命令恢复默认侧边栏：

```bash
dsh plugin --profile web remove @goodandready/dsh-session-control
```

原生 `ui-workspace` 模块将立即恢复启用，侧边栏恢复默认外观。所有置顶和隐藏配置安全保留在宿主存储中，重新安装插件后自动恢复。

---

## 核心功能

### 📌 会话置顶 (Pinned Sessions)
将高频核心对话置顶在侧边栏最上方的全局置顶区。由于配置存储在宿主端，置顶状态在页面刷新、更换浏览器或跨设备访问时均能持久保持。

### 🔍 上下文片段搜索 (Search with Snippets)
核心支持对话内容全文检索，`dsh-session-control` 在搜索结果中提取并展示匹配文本的上下文摘要行，无需打开会话即可快速确认匹配细节。

### 🗄️ 按时间段归档聚合 (Period-Based Archive)
归档会话按 *今天*、*本周*、*本月*、*更早* 进行分组折叠展示。折叠的时间段不会在 DOM 中渲染，即使存在数千个历史会话也不会造成界面卡顿。搜索时命中的时间段会自动展开。

### 📜 只读归档转录查看器 (Archived Transcript Viewer)
在核心中已归档的会话无法直接进入对话模式。插件通过独立服务端路由 `GET /dsh-session-control/transcript?session=<id>` 提供安全的只读转录弹窗，方便查阅历史对话与工具调用。

### 🧹 自动隐藏空白会话 (Hide Blank Sessions)
定时调度、消息网关及看板插件会持续创建无消息会话。插件默认自动隐藏空白会话，保持侧边栏整洁清爽。当前正在使用的会话即使为空也绝不会被隐藏。可在设置中自定义开启或关闭。

### 👁️ 可逆隐藏 (Reversible Hiding)
区别于核心单向的归档机制，插件提供轻量级的可逆隐藏功能，方便随时收起或恢复会话。

### ☑️ 多选与批量操作 (Batch Operations)
悬停复选框与 Shift 键区间连选，支持批量隐藏、批量取消隐藏及批量置顶。

### 🏷️ 标签 (Labels)
会话无法在工作文件夹之间移动：文件夹就是主机上的目录，归属由会话的工作目录推导，内核会拒绝
路径不符的会话。标签提供了文件夹给不了的分组维度：可在行菜单中为单个会话添加，也可一次性
作用于所选的一批；点击列表上方的标签即可只保留该标签的会话，归档会话同样在内。当最后一个
会话被移除后，标签会自动消失。

### 🧾 取自首条消息的名称 (Derived Names)
没有存储标题时，内核显示项目目录名，于是同一文件夹下的会话看起来完全一样。插件读取你在该
会话中发出的第一条消息作为名称。不调用模型，也不产生费用：文本本就在会话日志里。手动重命名
始终优先——一旦命名，推导出的名称即刻让位。只解析当前显示的行，因此折叠的分区没有任何开销。

### ⌨️ 快速跳转 (`Ctrl+K`)
在界面之上打开搜索窗口，同时按标题和消息内容检索。方向键移动，`Enter` 打开，`Esc` 关闭并把
焦点交还原处。归档结果以只读转录方式打开，与在列表中点击一致。

### 📤 Markdown 导出 (Export)
转录窗口可将会话复制到剪贴板，或保存为 `.md` 文件。被截断的转录会在导出内容中明确标注，避免
把片段误当作完整对话。

### ✏️ 就地快速重命名 (In-Place Rename)
双击会话标题或按下 `F2` 快捷键即可直接在列表中重命名。

---

## 配置项

前往 **设置 → 插件 → 插件设置 → 会话控制 (dsh-session-control)**：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `pinned` | `string[]` | `[]` | 置顶会话 ID 列表（数组顺序决定展示顺序） |
| `hidden` | `string[]` | `[]` | 可逆隐藏的会话 ID 列表 |
| `hideBlank` | `boolean` | `true` | 是否自动隐藏无消息的空白会话 |
| `labels` | `Record<string, string[]>` | `{}` | 标签名称与其包含的会话 ID |

所有设置均持久保存在宿主端并在所有客户端间同步。

---

## 设计约束说明

* **不支持跨工作区移动会话：** 工作区与本地磁盘目录绑定，会话归属由其工作目录 (`cwd`) 决定，核心注册表严格校验路径一致性。
* **不支持从归档恢复：** Harness 核心目前仅提供归档接口，未提供反归档 API。归档会话可通过转录查看器安全只读查阅。
* **早期日志格式兼容：** 早期格式的历史日志若无法被核心反序列化，插件会展示清晰说明提示，避免错误显示为“无消息”。
* **不支持物理硬删除：** 核心公共接口未开放硬删除方法，插件严格遵循安全规范。

---

## 架构与可靠性

插件采用严谨的**双半区架构**设计以确保最高可靠性：

1. **服务半区 (`uiWorkspace` 提供者):**
   * 被替换的原生 `ui-workspace` 负责导出核心服务 `uiWorkspace`，该服务是 `dsh-client-ui-sidebar` 和 `dsh-client-ui-conversation` 的强依赖项。
   * 插件的服务半区以零 React 渲染、零额外逻辑的极轻量方式提供该服务与根 Hooks。
2. **界面半区 (UI & Views):**
   * 包含工作区树、搜索列表、转录弹窗及设置卡片。
   * 完全由错误边界 (Error Boundaries) 保护，即使 UI 发生异常也不会影响侧边栏其他部分及主聊天界面的正常运行。
3. **服务端路由:**
   * 提供 `GET /dsh-session-control/transcript` 路由，安全解析并流式读取归档 JSONL 日志。

---

## 语言与本地化

插件核心内置英语文本。俄语及中文等多语言支持通过语言包扩展（如 `@goodandready/dsh-russian-lang`）。词典注册具备容错保护，不会因冲突引发异常。

---

## 兼容性

- 经验证支持 DeepSeek Harness `0.1.2-rc.1` 与 `0.1.3-alpha.1`。
- 支持 Node.js `^20.19.0` 或 `>=22.12.0`。
- 与 `@goodandready/dsh-lanmode`、`@goodandready/dsh-kanban`、`@goodandready/dsh-cron` 等 DSH 插件无缝协同工作。

---

## 许可证

MIT © GoodAndReady
