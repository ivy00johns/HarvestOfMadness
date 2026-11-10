---
title: "4.1 Sense — `Observation`"
tags: ["4-1-sense-observation"]
paths: []
updated: 2026-11-10
---

Imported from `docs/deep-research-v1.md:60` by Andon (import docs/deep-research-v1.md:60 e45635aaf91cbde7); the original stays there.

```ts
interface Observation {
  self: { name:string; persona:string; role:string;
          pos:{x:number;y:number}; energy:number; gold:number;
          inventory:{itemId:string;qty:number}[]; goal:string|null; };
  time: { day:number; phase:"morning"|"afternoon"|"evening"|"night" };
  nearby: {
    tiles:{x:number;y:number;type:TileType;
           crop?:{kind:string;stage:number;watered:boolean;ready:boolean}}[]; // radius ~4
    agents:{name:string;pos:{x:number;y:number};lastSeenDoing:string}[];
    landmarks:{kind:"shop"|"bed"|"water"|"house";pos:{x:number;y:number}}[];
  };
  lastAction:{action:string;ok:boolean;reason?:string}|null;  // feedback for self-correction
  availableActions: ActionType[];
  economy:{sells:Record<string,number>;buys:Record<string,number>};
}
```
