# pi-mnemosyne

Pi extension for **local persistent memory** using [Mnemosyne](https://github.com/gandazgul/mnemosyne). Gives your AI coding agent memory that persists across sessions — entirely offline, no cloud APIs.

## Prerequisites

Install the mnemosyne binary first:

```bash
# From source (requires Go 1.21+, GCC, Task)
git clone https://github.com/gandazgul/mnemosyne.git
cd mnemosyne
task install
```

See the [mnemosyne README](https://github.com/gandazgul/mnemosyne#quick-start) for detailed setup instructions. On first use, mnemosyne will automatically download its ML models (~500 MB one-time).

## Install

```bash
# From npm (when published)
pi install npm:pi-mnemosyne

# From local path (for development)
pi install ./pi-mnemosyne
```

## What it does

### Core Memories

Core memories are tagged with `core` and **automatically injected into the system prompt** at the start of every session (and after compaction). They work like `AGENTS.md` — always-available context that the agent can reference without explicitly searching.

Use core memories for:
- Project architecture and key conventions
- Important user preferences
- Critical decisions that should never be forgotten

**Keep core memories lean** — they're injected into every prompt and consume context tokens.

### Tools

The extension registers five tools available to the AI agent:

| Tool | Description |
|------|-------------|
| `memory_recall` | Search project memory for relevant context and past decisions |
| `memory_recall_global` | Search global memory for cross-project preferences |
| `memory_store` | Store a project-scoped memory (optionally as `core`) |
| `memory_store_global` | Store a cross-project memory (optionally as `core`) |
| `memory_delete` | Delete an outdated memory by its document ID |

### Memory Scoping

| Scope | Collection | Persists across |
|-------|-----------|-----------------|
| Project | `<directory-name>` | Sessions in the same project |
| Global | `global` | All projects |
| Core (project) | `<directory-name>` (tagged `core`) | Sessions + injected into system prompt |
| Core (global) | `global` (tagged `core`) | All projects + injected into system prompt |

The project collection is auto-initialized when the extension loads. The global collection is created on first use of `memory_store_global`.

## How it works

Mnemosyne is a local document store with hybrid search:
- **Full-text search** (SQLite FTS5, BM25 ranking)
- **Vector search** (sqlite-vec, cosine similarity with snowflake-arctic-embed-m-v1.5)
- **Reciprocal Rank Fusion** combines both for best results

All ML inference runs locally via ONNX Runtime. Your memories never leave your machine.

### Architecture

```
Session start
  │
  ├─► Auto-init project collection (mnemosyne init)
  └─► Fetch core memories (local + global, tagged "core")
      │
      ▼
  Cached in memory
      │
Each turn (before_agent_start)
  │
  └─► Append cached core memories to system prompt
      (provider-cached, survives compaction)

Agent uses tools
  │
  ├─► memory_recall / memory_recall_global → mnemosyne search
  ├─► memory_store / memory_store_global → mnemosyne add [--tag core]
  │     └─► If core=true → invalidate cache (re-fetched next turn)
  └─► memory_delete → mnemosyne delete
        └─► Invalidate cache (re-fetched next turn)
```

## Development

```bash
# Link locally for development
pi install ./pi-mnemosyne

# Check it's installed
pi list

# Start pi — the extension loads automatically
pi
```

The extension uses TypeScript with pi's built-in jiti loader — no build step required.

## License

MIT
