# @goodandready/dsh-session-control

[English](README.md) | [Русский](docs/README.ru.md) | [中文](docs/README.zh.md)

[![npm version](https://img.shields.io/npm/v/@goodandready/dsh-session-control.svg?style=flat-square)](https://www.npmjs.com/package/@goodandready/dsh-session-control)
[![npm downloads](https://img.shields.io/npm/dm/@goodandready/dsh-session-control.svg?style=flat-square)](https://www.npmjs.com/package/@goodandready/dsh-session-control)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![DeepSeek Harness](https://img.shields.io/badge/DSH-Plugin-blue.svg?style=flat-square)](https://goodandready.app)

Advanced session management for the **DeepSeek Harness** sidebar: pin essential conversations, search conversation contents with match snippets, read archived transcripts in an isolated modal, hide noise, and manage multiple sessions with bulk actions.

---

## What the Plugin Does to the Sidebar

The plugin **replaces the body of the sidebar** — the section containing the workspace and session lists. The rest of the sidebar remains completely stock: branding, the new session button, footer, and navigation to settings remain untouched.

Replacement is intentional and architecturally required: the `sidebar.workspaces` slot is declared by the harness core as `kind: "single"`, which does not allow secondary registrants, and no other extension slots exist in the sidebar body.

---

## Comparison: Stock Sidebar vs. dsh-session-control

| Capability | Stock Sidebar | With `dsh-session-control` |
|---|---|---|
| **Pin Conversations** | ❌ None | ✅ Global pinned section at the top of the sidebar |
| **Archive Section** | ❌ Completely hidden | ✅ Dedicated section grouped by time periods |
| **Read Archived Sessions** | ❌ Impossible | ✅ Read-only full transcript viewer modal |
| **Search Results** | ⚠️ Title only | ✅ Title + contextual match snippet preview |
| **Blank Sessions** | ⚠️ Mixed with active ones | ✅ Hidden automatically (except current active session) |
| **Bulk Actions** | ❌ None | ✅ Multi-selection with checkboxes and Shift+Click ranges |
| **Reversible Hiding** | ❌ Only irreversible archive | ✅ Reversible one-click hide / unhide |
| **Active Session Indicator** | ❌ Not indicated | ✅ Live running pulse dot in row |
| **In-Place Rename** | ⚠️ Modal prompt | ✅ Inline double-click or F2 edit |
| **Cross-Folder Grouping** | ❌ Impossible (membership follows the working directory) | ✅ Own labels, independent of folders |
| **Conversation Names** | ⚠️ Project folder name for every untitled session | ✅ Derived from the first message you sent |
| **Keyboard Navigation** | ❌ None | ✅ `Ctrl+K` quick jump across active and archived sessions |
| **Taking Content Out** | ❌ Impossible | ✅ Copy or save any transcript as Markdown |

> Standard harness features — workspaces, deep conversation search, and branching sessions — remain fully intact: the plugin reuses and enhances them rather than reinventing them.

---

## Installation

Install via the `dsh` CLI for your web profile:

```bash
dsh plugin --profile web add @goodandready/dsh-session-control
```

Restart the DeepSeek Harness web profile to activate the bundle patch.

---

## How to Restore the Stock Sidebar

To revert to the stock sidebar at any time:

```bash
dsh plugin --profile web remove @goodandready/dsh-session-control
```

The stock `ui-workspace` row is instantly re-enabled, returning the sidebar to its default look. All pinned and hidden session preferences are preserved in host storage and will seamlessly reapply if the plugin is installed again.

---

## Features

### 📌 Pinned Sessions
Pin important conversations to a dedicated, globally visible top group above workspaces. Pinned sessions survive page reloads, browser switches, and device migrations because configuration is persisted in host storage.

### 🔍 Search with Contextual Snippets
The core searches conversation contents and returns context around the matching query — `dsh-session-control` displays this preview as a second line under the session title so you immediately see why a conversation matched without opening it.

### 🗄️ Period-Based Archive
Organized into intuitive collapsible periods: *Today*, *This Week*, *This Month*, and *Older*. Collapsed periods are unmounted from the DOM, preventing performance degradation even with thousands of historical sessions. Active search automatically expands relevant periods.

### 📜 Read-Only Archived Transcript Viewer
Archived sessions cannot be opened for active chatting in the core. The plugin provides an isolated, read-only transcript viewer modal via `GET /dsh-session-control/transcript?session=<id>` to inspect past agent turns, tools called, and user prompts safely.

### 🧹 Automatic Noise Reduction (Hide Blank Sessions)
Automated schedulers, messenger gateways, and kanban boards continuously spawn sessions without messages. Blank sessions are hidden by default to keep the sidebar clean. The active session is never hidden even if empty. Toggleable via settings.

### 👁️ Reversible Session Hiding
Unlike core archiving which is one-way, `dsh-session-control` offers lightweight reversible hiding for active sessions you temporarily want out of view.

### ☑️ Multi-Select & Batch Operations
Hover checkboxes and Shift+Click range selection allow batch hiding, unhiding, and pinning of dozens of sessions simultaneously.

### ✏️ In-Place Inline Renaming
Rename conversations instantly with a double click on the title or by pressing `F2`.

### 🏷️ Labels
A session cannot be moved between workspaces — membership is derived from its working
directory, and the core rejects any session whose `cwd` does not match the folder path.
Labels give the grouping axis the folders cannot: assign one from the row menu or to a
whole selection at once, then filter the panel — archive included — by clicking a chip
above the list. A label that loses its last session disappears on its own.

### 🧾 Names Derived From Your First Message
Without a stored title the core shows the project folder name, so every conversation in a
folder looks the same. The plugin reads the first message you sent in that session and
uses it as the label. No model call and no cost: the text is already in the session log.
Renaming always wins — once you name a conversation, the derived label is gone. Only the
rows currently on screen are resolved, so collapsed sections cost nothing.

### ⌨️ Quick Jump (`Ctrl+K`)
Opens a palette over the interface that searches titles and message contents at once.
Arrows move, `Enter` opens, `Esc` closes and returns the focus where it was. An archived
result opens as a transcript, exactly as it does in the list.

### 📤 Markdown Export
The transcript window can copy the conversation to the clipboard or save it as a `.md`
file. A truncated transcript says so in the export itself, so a fragment is never mistaken
for the whole conversation.

---

## Configuration

Navigate to **Settings → Plugins → Plugin Settings → Session Control**:

| Setting | Type | Default | Description |
|---|---|---|---|
| `pinned` | `string[]` | `[]` | Array of pinned session IDs (array order determines display order) |
| `hidden` | `string[]` | `[]` | Array of reversibly hidden session IDs |
| `hideBlank` | `boolean` | `true` | Automatically hide sessions with zero messages |
| `labels` | `Record<string, string[]>` | `{}` | Label name to the session IDs carrying it |

All settings are stored on the host and synchronize across client instances.

---

## Intentional Constraints

* **No cross-workspace session moving:** Workspaces represent distinct disk directories. Session membership is derived directly from the session's working directory (`cwd`). The core registry strictly enforces this binding.
* **No unarchiving:** DeepSeek Harness core provides an archive operation but no unarchive API method. Archived sessions remain accessible via the read-only transcript viewer.
* **Legacy log format handling:** Older legacy session logs that cannot be deserialized by the core are gracefully flagged with descriptive notices rather than displaying a false "no messages" state.
* **No session hard deletion:** Session deletion is not exposed in public harness APIs, and the plugin adheres strictly to safe API contracts.

---

## Architecture & Reliability

The plugin utilizes a decoupled **two-half architecture** for maximum resilience:

1. **Service Half (`uiWorkspace` Provider):**
   * The replaced core `ui-workspace` module exports a required service `uiWorkspace` that is an essential dependency for `dsh-client-ui-sidebar` and `dsh-client-ui-conversation`.
   * The plugin's service half delivers this service and root hooks cleanly with zero React rendering and zero plugin logic overhead.
2. **Interface Half (UI & Views):**
   * Encapsulates the custom workspace tree, search results, transcript modal, and settings card.
   * Completely wrapped in defensive error boundaries. If a UI exception occurs, the main sidebar, conversation pane, and settings remain fully operational.
3. **Server Route:**
   * Exposes `GET /dsh-session-control/transcript` to parse and stream archived JSONL session logs safely without loading heavy unneeded payloads.

---

## UI Localization

The plugin core ships with English strings by default. Multilingual localizations (including Russian and Chinese) are loaded through language packs (such as `@goodandready/dsh-russian-lang`). Dictionary registration is fail-safe and never degrades sidebar functionality.

---

## Compatibility

- Tested with DeepSeek Harness `0.1.2-rc.1` and `0.1.3-alpha.1`.
- Compatible with Node.js `^20.19.0` or `>=22.12.0`.
- Seamlessly integrates alongside `@goodandready/dsh-lanmode`, `@goodandready/dsh-kanban`, `@goodandready/dsh-cron`, and other DSH plugins.

---

## License

MIT © GoodAndReady
