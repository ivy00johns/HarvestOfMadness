---
title: "13. Repo structure"
tags: ["13-repo-structure"]
paths: [index.html, package.json, tsconfig.json, vite.config.ts, README.md, PROVENANCE.md, public/assets, main.ts, config.ts, world.ts, BootScene.ts, WorldScene.ts, UIScene.ts, Grid.ts, Tile.ts, TimeSystem.ts, Economy.ts, Pathfinding.ts, Agent.ts, AgentManager.ts]
updated: 2026-11-10
---

Imported from `docs/deep-research-v1.md:198` by Andon (import docs/deep-research-v1.md:198 48030e355a3aec2a); the original stays there.

```
HarvestOfMadness/
  index.html  package.json  tsconfig.json  vite.config.ts  .env.example
  README.md  PROVENANCE.md                 # borrowed-file → origin + refactor notes
  vendor/                                   # raw lifted modules pre-refactor (optional staging)
  public/assets/                            # optional art; placeholder-graphics fallback in code
  src/
    main.ts  config.ts  world.ts            # bootstrap, constants, code-gen tilemap
    scenes/  BootScene.ts  WorldScene.ts  UIScene.ts
    world/   Grid.ts  Tile.ts  TimeSystem.ts  Economy.ts  Pathfinding.ts   # NEW
    agents/  Agent.ts  AgentManager.ts  AgentRuntime.ts                    # refactored PDoM
             Observation.ts  ActionSchema.ts  ActionExecutor.ts  personas.ts # NEW + borrowed
    llm/     router.ts  prompts.ts          # seam + borrowed prompt pattern
    obs/     EventLog.ts  Inspector.ts  session.ts   # refactored PDoM
  server/                                   # live mode only
    index.ts                                # Express proxy
    llm/  pool.ts  route.ts  fallback.ts  limits.ts  parse.ts  # vendored FreeLLMAPI, refactored
```
