/**
 * STUB — llm-agent (W1) replaces this file with the real FreeLLMAPI proxy
 * (server/index.ts + server/llm/*). Until then it only answers /api/health
 * so the dev workflow and Vite proxy can be verified end to end.
 */
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    upstream: "unreachable",
    decisionsToday: 0,
    dailyCeiling: 0,
  });
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`[server] stub proxy listening on http://localhost:${port}`);
});
