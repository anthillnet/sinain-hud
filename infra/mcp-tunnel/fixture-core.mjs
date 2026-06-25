#!/usr/bin/env node
// Fixture "sinain-core" for the OpenAI-review demo account. Serves canned,
// realistic responses for the endpoints the real MCP server calls, so reviewers
// logging into the demo account see the tools work with zero config. Plain Node.
// The REAL sinain-mcp-server runs in front of this (SINAIN_CORE_URL=this), so
// reviewers exercise the exact tool surface + annotations. See
// docs/CHATGPT-APP-SUBMISSION.md §6.

import http from "node:http";

const PORT = Number(process.env.FIXTURE_CORE_PORT || 9530);

// A coherent sample session: someone building a Python data pipeline.
const DIGEST = {
  hud: "Debugging a failing test in the ingest pipeline",
  digest: "The user is editing `pipeline/ingest.py` in VS Code and running pytest. " +
    "A test `test_dedup_rows` is failing with a KeyError on 'order_id'. They're " +
    "comparing the dataframe schema against the expected columns.",
  confidence: 0.82,
};
const CONTEXT = {
  currentApp: "Visual Studio Code",
  recentApps: ["Visual Studio Code", "iTerm2", "Google Chrome"],
  screen: [
    "pipeline/ingest.py — def dedup_rows(df): return df.drop_duplicates(subset=['order_id'])",
    "TERMINAL: pytest -k dedup  → KeyError: 'order_id'",
    "Chrome: pandas.DataFrame.drop_duplicates — documentation",
  ],
  audio: [
    "…so the dedup should key on order id but the column is actually orderId…",
  ],
};
const ROI = {
  ok: true, id: "demo-roi-1", regionId: "r1",
  seed: {
    text: "[Region the user flagged]\nLine: return df.drop_duplicates(subset=['order_id'])\n" +
      "The column in the dataframe is `orderId` (camelCase), but the code uses `order_id`. " +
      "Help fix the KeyError.",
  },
};
const FACTS =
  "- sinain-demo prefers: pandas for ETL (confidence 0.9)\n" +
  "- ingest-pipeline status: refactoring dedup logic (confidence 0.8)\n" +
  "- sinain-demo deadline: ship v1 ingest by Friday (confidence 0.7)";
const KNOWLEDGE =
  "# Sinain demo knowledge\n\n## Playbook\n- The ingest pipeline reads orders CSVs and dedups by order id.\n\n" +
  "## Top facts\n" + FACTS;

function json(res, obj, code = 200) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const path = (req.url || "").split("?")[0].replace(/\/$/, "") || "/";
  if (req.method === "GET") {
    switch (path) {
      case "/health": return json(res, { ok: true, status: "healthy", demo: true });
      case "/agent/digest": return json(res, DIGEST);
      case "/agent/context": return json(res, CONTEXT);
      case "/roi/pending": return json(res, ROI);
      case "/knowledge": return json(res, { ok: true, content: KNOWLEDGE });
      case "/knowledge/facts": return json(res, { ok: true, facts: FACTS });
      case "/escalation/pending": return json(res, { status: "none" });
    }
  }
  if (req.method === "POST") {
    // Drain the body, then ack. (Writes are no-ops in the demo fixture.)
    let n = 0; req.on("data", (c) => { n += c.length; if (n > 64 * 1024) req.destroy(); });
    req.on("end", () => {
      switch (path) {
        case "/escalation/respond": return json(res, { ok: true, accepted: true });
        case "/feed": return json(res, { ok: true, posted: true });
        case "/knowledge/import": return json(res, { ok: true, stored: 1 });
        default: return json(res, { ok: true });
      }
    });
    return;
  }
  json(res, { ok: false, error: "not_found" }, 404);
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`sinain fixture-core (demo) on http://127.0.0.1:${PORT}`);
});
