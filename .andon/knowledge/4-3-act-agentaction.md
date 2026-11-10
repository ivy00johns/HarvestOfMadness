---
title: "4.3 Act — `AgentAction`"
tags: ["4-3-act-agentaction"]
paths: []
updated: 2026-11-10
---

Imported from `docs/deep-research-v1.md:84` by Andon (import docs/deep-research-v1.md:84 f5cfe9aacca0176b); the original stays there.

```ts
type ActionType = "MOVE_TO"|"TILL"|"PLANT"|"WATER"|"HARVEST"
                |"BUY"|"SELL"|"TALK_TO"|"SLEEP"|"WAIT";
interface AgentAction {
  thought:string; say:string|null; action:ActionType;
  target?: {x:number;y:number} | {itemId:string;qty:number} | {agentName:string};
  goal?:string;
}
```
