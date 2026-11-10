---
title: "5. Architecture & seams"
tags: ["5-architecture-seams"]
paths: [router.ts]
updated: 2026-11-10
---

Imported from `docs/deep-research-v1.md:112` by Andon (import docs/deep-research-v1.md:112 d0b81eba3ee2263d); the original stays there.

```mermaid
flowchart LR
  subgraph Browser["Phaser 4 (browser) — NEW + refactored PDoM"]
    WS[WorldScene render+loop] --> WORLD[(World state)]
    AM[AgentManager async scheduler] --> WORLD
    AM --> OBS[event log / inspector bus]
    OBS --> UI[UIScene HUD+inspector]
  end
  AM -->|LlmRequest| RT{router.ts seam}
  RT -->|mock| MOCK[mockRouter $0]
  RT -->|live| PROXY[/Express proxy/]
  PROXY --> FREE[vendored FreeLLMAPI router<br/>pool · route · fallback · Ollama]
```

**Three seams where borrowed code plugs in:**

1. **`Router`** (§11) — FreeLLMAPI conforms to this; client never imports it directly.

2. **`AgentRuntime`/scheduler** (§6) — refactored PDoM pipeline conforms to the async scheduler API.

3. **`Inspector` data model** (§9) — refactored PDoM observability feeds the Phaser HUD.

New code consumes these seams; borrowed code is shaped *to* them.
