#!/usr/bin/env python3
"""Knowledge Integrator — update playbook + knowledge graph from a SessionDigest.

Takes a session digest (from session_distiller.py), the current playbook, and
the knowledge graph, then produces:
1. Updated playbook (working memory)
2. Graph operations (long-term memory: assert/reinforce/retract facts)

Single LLM call, ~15s. Replaces: playbook_curator + feedback_analyzer +
triple_extractor + triple_ingest.

Usage:
    python3 knowledge_integrator.py --memory-dir memory/ \
        --digest '{"whatHappened":"...","patterns":[...]}' \
        [--bootstrap]  # one-time: seed graph from current playbook
"""

import argparse
import hashlib
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

from common import (
    LLMError,
    call_llm_with_fallback,
    extract_json,
    output_json,
    read_playbook,
)

SYSTEM_PROMPT = """\
You are a knowledge integrator for a personal AI overlay system (sinain).
You maintain TWO knowledge stores:

1. PLAYBOOK (working memory, ~50 lines): actively curated patterns, anti-patterns,
   and preferences. Injected into every agent prompt. Must be concise and current.

2. KNOWLEDGE GRAPH (long-term memory): durable facts that survive playbook pruning.
   Stored as entity-attribute-value triples. Facts can be reinforced (seen again),
   retracted (contradicted or outdated), or newly asserted.

Given a session digest (what happened), the current playbook, and existing graph facts:

FOR THE PLAYBOOK:
- ADD patterns from the digest that are novel (not already in playbook)
- REINFORCE existing patterns that the session confirms (increment "seen" count)
- PRUNE patterns contradicted by session evidence
- PROMOTE frequently-reinforced patterns (seen 3+) to "established"
- Keep under 50 lines. Density over completeness.
- DO NOT modify header/footer comments (<!-- mining-index ... --> and <!-- effectiveness ... -->)
- Three Laws: (1) don't remove error-prevention patterns, (2) preserve high-scoring approaches, (3) then evolve

FOR THE KNOWLEDGE GRAPH:
- ASSERT new durable facts (error→fix mappings, domain knowledge, user expertise)
- REINFORCE existing facts confirmed by the session (list their entity_ids)
- RETRACT facts contradicted by session evidence (list their entity_ids)
- Each fact needs: entity (domain/tool/workflow), attribute (relationship type), value (the knowledge), confidence (0.0-1.0), domain (for module scoping)
- Entity naming: use lowercase-hyphenated slugs (e.g., "react-native", "metro-bundler")
- Only assert DURABLE facts — not ephemeral session details

If the session was empty/idle, return minimal changes.

Respond with ONLY a JSON object:
{
  "updatedPlaybook": "full playbook body text (between header and footer comments)",
  "changes": {
    "added": ["pattern text", ...],
    "pruned": ["pattern text", ...],
    "promoted": ["pattern text", ...],
    "reinforced": ["pattern text", ...]
  },
  "graphOps": [
    {"op": "assert", "entity": "entity-slug", "attribute": "attr-name", "value": "fact text", "confidence": 0.8, "domain": "domain-name"},
    {"op": "reinforce", "entityId": "fact:existing-slug"},
    {"op": "retract", "entityId": "fact:existing-slug", "reason": "why"}
  ]
}"""


def _fact_id(entity: str, attribute: str, value: str) -> str:
    """Generate a deterministic fact entity ID from entity+attribute+value."""
    content = f"{entity}:{attribute}:{value}"
    h = hashlib.sha256(content.encode()).hexdigest()[:12]
    slug = entity.replace(" ", "-").lower()[:30]
    return f"fact:{slug}-{h}"


def _load_graph_facts(db_path: str, entities: list[str] | None = None, limit: int = 50) -> list[dict]:
    """Load relevant facts from the knowledge graph for LLM context."""
    if not Path(db_path).exists():
        return []

    try:
        from triplestore import TripleStore
        store = TripleStore(db_path)

        # Get all non-retracted fact entities with their attributes
        if entities:
            # Entity-scoped query: find facts related to specified domains
            domain_clause = " OR ".join([f"value = ?" for _ in entities])
            rows = store._conn.execute(
                f"""SELECT DISTINCT entity_id FROM triples
                    WHERE attribute = 'domain' AND NOT retracted
                    AND ({domain_clause})
                    LIMIT ?""",
                (*entities, limit),
            ).fetchall()
            fact_ids = [r["entity_id"] for r in rows]
        else:
            # Top-N by confidence
            rows = store._conn.execute(
                """SELECT entity_id, CAST(value AS REAL) as conf
                   FROM triples
                   WHERE attribute = 'confidence' AND NOT retracted
                   AND entity_id LIKE 'fact:%'
                   ORDER BY conf DESC
                   LIMIT ?""",
                (limit,),
            ).fetchall()
            fact_ids = [r["entity_id"] for r in rows]

        facts = []
        for fid in fact_ids:
            attrs = store.entity(fid)
            if attrs:
                fact = {"entityId": fid}
                for attr_name, values in attrs.items():
                    fact[attr_name] = values[0] if len(values) == 1 else values
                facts.append(fact)

        store.close()
        return facts
    except Exception as e:
        print(f"[warn] Failed to load graph facts: {e}", file=sys.stderr)
        return []


def _execute_graph_ops(db_path: str, ops: list[dict], digest_ts: str) -> dict:
    """Execute graph operations (assert/reinforce/retract) on the knowledge graph."""
    if not ops:
        return {"asserted": 0, "reinforced": 0, "retracted": 0}

    try:
        from triplestore import TripleStore
        store = TripleStore(db_path)
        stats = {"asserted": 0, "reinforced": 0, "retracted": 0}

        for op_data in ops:
            op = op_data.get("op", "")

            if op == "assert":
                entity = op_data.get("entity", "")
                attribute = op_data.get("attribute", "")
                value = op_data.get("value", "")
                confidence = op_data.get("confidence", 0.7)
                domain = op_data.get("domain", "")

                if not entity or not attribute or not value:
                    continue

                entity_id = _fact_id(entity, attribute, value)
                tx = store.begin_tx("knowledge_integrator", metadata=json.dumps({"digest_ts": digest_ts}))
                store.assert_triple(tx, entity_id, "entity", entity)
                store.assert_triple(tx, entity_id, "attribute", attribute)
                store.assert_triple(tx, entity_id, "value", value)
                store.assert_triple(tx, entity_id, "confidence", str(confidence))
                store.assert_triple(tx, entity_id, "first_seen", digest_ts)
                store.assert_triple(tx, entity_id, "last_reinforced", digest_ts)
                store.assert_triple(tx, entity_id, "reinforce_count", "1")
                if domain:
                    store.assert_triple(tx, entity_id, "domain", domain)
                stats["asserted"] += 1

            elif op == "reinforce":
                entity_id = op_data.get("entityId", "")
                if not entity_id:
                    continue

                # Read current confidence and reinforce count
                attrs = store.entity(entity_id)
                if not attrs:
                    continue

                cur_conf = 0.5
                cur_count = 0
                if "confidence" in attrs:
                    try:
                        cur_conf = float(attrs["confidence"][0])
                    except (ValueError, IndexError):
                        pass
                if "reinforce_count" in attrs:
                    try:
                        cur_count = int(attrs["reinforce_count"][0])
                    except (ValueError, IndexError):
                            pass

                new_conf = min(1.0, cur_conf + 0.15)
                new_count = cur_count + 1

                tx = store.begin_tx("knowledge_integrator", metadata=json.dumps({
                    "op": "reinforce", "entity_id": entity_id, "digest_ts": digest_ts
                }))
                # Retract old values, assert new
                store.retract_triple(tx, entity_id, "confidence", str(cur_conf))
                store.assert_triple(tx, entity_id, "confidence", str(round(new_conf, 2)))
                store.retract_triple(tx, entity_id, "reinforce_count", str(cur_count))
                store.assert_triple(tx, entity_id, "reinforce_count", str(new_count))
                # Retract old last_reinforced if present
                old_reinforced = attrs.get("last_reinforced", [])
                for val in old_reinforced:
                    store.retract_triple(tx, entity_id, "last_reinforced", val)
                store.assert_triple(tx, entity_id, "last_reinforced", digest_ts)
                stats["reinforced"] += 1

            elif op == "retract":
                entity_id = op_data.get("entityId", "")
                reason = op_data.get("reason", "")
                if not entity_id:
                    continue

                tx = store.begin_tx("knowledge_integrator", metadata=json.dumps({
                    "op": "retract", "entity_id": entity_id, "reason": reason, "digest_ts": digest_ts
                }))
                # Retract all attributes of this entity
                attrs = store.entity(entity_id)
                for attr_name, values in attrs.items():
                    for val in values:
                        store.retract_triple(tx, entity_id, attr_name, val)
                stats["retracted"] += 1

        store.close()
        return stats
    except Exception as e:
        print(f"[warn] Failed to execute graph ops: {e}", file=sys.stderr)
        return {"asserted": 0, "reinforced": 0, "retracted": 0, "error": str(e)}


def _extract_header_footer(playbook: str) -> tuple[str, str, str]:
    """Split playbook into (header, body, footer)."""
    lines = playbook.splitlines()
    header_lines: list[str] = []
    footer_lines: list[str] = []
    body_lines: list[str] = []

    in_header = True
    for line in lines:
        stripped = line.strip()
        if in_header and stripped.startswith("<!--"):
            header_lines.append(line)
            continue
        in_header = False
        if stripped.startswith("<!-- effectiveness"):
            footer_lines.append(line)
        else:
            body_lines.append(line)

    return "\n".join(header_lines), "\n".join(body_lines), "\n".join(footer_lines)


def _archive_playbook(memory_dir: str) -> str | None:
    """Archive current playbook. Returns archive path or None."""
    src = Path(memory_dir) / "sinain-playbook.md"
    if not src.exists():
        return None

    archive_dir = Path(memory_dir) / "playbook-archive"
    archive_dir.mkdir(parents=True, exist_ok=True)

    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d-%H%M")
    dest = archive_dir / f"sinain-playbook-{ts}.md"
    shutil.copy2(src, dest)
    return str(dest)


def _bootstrap_graph(memory_dir: str, db_path: str) -> dict:
    """One-time: seed knowledge graph from current playbook patterns."""
    playbook = read_playbook(memory_dir)
    if not playbook:
        return {"bootstrapped": 0}

    import re
    # Extract patterns from playbook (lines starting with "- ")
    patterns = []
    for line in playbook.splitlines():
        line = line.strip()
        if line.startswith("- ") and ("score" in line or "seen" in line):
            patterns.append(line[2:])

    if not patterns:
        return {"bootstrapped": 0}

    # Generate assert ops for each pattern
    ops = []
    for pattern in patterns:
        # Extract score if present
        score_match = re.search(r"score\s*[\d.]+", pattern)
        confidence = 0.6
        if score_match:
            try:
                confidence = float(re.search(r"[\d.]+", score_match.group()).group())
            except (ValueError, AttributeError):
                pass

        # Determine domain from pattern text (basic heuristic)
        domain = "general"
        domain_keywords = {
            "react": "react-native", "metro": "react-native", "flutter": "flutter",
            "ocr": "vision", "audio": "audio", "hud": "sinain-hud",
            "docker": "infrastructure", "ssh": "infrastructure", "deploy": "infrastructure",
            "intellij": "intellij", "psi": "intellij", "claude": "ai-agents",
            "gemini": "ai-agents", "openrouter": "ai-agents", "escalation": "sinain-core",
        }
        lower = pattern.lower()
        for kw, dom in domain_keywords.items():
            if kw in lower:
                domain = dom
                break

        ops.append({
            "op": "assert",
            "entity": domain,
            "attribute": "pattern",
            "value": pattern[:200],
            "confidence": confidence,
            "domain": domain,
        })

    now = datetime.now(timezone.utc).isoformat()
    stats = _execute_graph_ops(db_path, ops, now)
    return {"bootstrapped": stats.get("asserted", 0)}


def main() -> None:
    parser = argparse.ArgumentParser(description="Knowledge Integrator")
    parser.add_argument("--memory-dir", required=True, help="Path to memory/ directory")
    parser.add_argument("--digest", default=None, help="SessionDigest JSON string")
    parser.add_argument("--bootstrap", action="store_true", help="One-time: seed graph from playbook")
    args = parser.parse_args()

    memory_dir = args.memory_dir
    db_path = str(Path(memory_dir) / "knowledge-graph.db")

    # Bootstrap mode: seed graph from current playbook
    if args.bootstrap:
        result = _bootstrap_graph(memory_dir, db_path)
        output_json(result)
        return

    # Normal mode: integrate session digest
    if not args.digest:
        print("--digest is required (unless --bootstrap)", file=sys.stderr)
        output_json({"error": "--digest required"})
        return

    try:
        digest = json.loads(args.digest)
    except json.JSONDecodeError as e:
        output_json({"error": f"Invalid digest JSON: {e}"})
        return

    # Skip if digest indicates empty session
    if digest.get("isEmpty", False):
        output_json({"skipped": True, "reason": "empty session"})
        return

    # Read current playbook
    playbook = read_playbook(memory_dir)
    header, body, footer = _extract_header_footer(playbook)

    # Load relevant graph facts for LLM context
    digest_entities = digest.get("entities", [])
    existing_facts = _load_graph_facts(db_path, entities=digest_entities if digest_entities else None)

    # Build user prompt
    facts_text = ""
    if existing_facts:
        facts_lines = []
        for f in existing_facts[:30]:
            eid = f.get("entityId", "?")
            val = f.get("value", "")
            conf = f.get("confidence", "?")
            domain = f.get("domain", "?")
            facts_lines.append(f"- [{eid}] ({domain}, confidence={conf}) {val}")
        facts_text = f"\n\n## Existing Graph Facts (for reference — reinforce or retract as needed)\n" + "\n".join(facts_lines)

    user_prompt = f"""## Session Digest
{json.dumps(digest, indent=2, ensure_ascii=False)}

## Current Playbook Body
{body}{facts_text}"""

    try:
        raw = call_llm_with_fallback(
            SYSTEM_PROMPT,
            user_prompt,
            script="knowledge_integrator",
            json_mode=True,
        )
        result = extract_json(raw)
    except (ValueError, LLMError) as e:
        print(f"LLM integration failed: {e}", file=sys.stderr)
        output_json({"error": str(e)})
        return

    # Archive current playbook before mutation
    archive_path = _archive_playbook(memory_dir)

    # Write updated playbook
    updated_body = result.get("updatedPlaybook", body)
    new_playbook = f"{header}\n\n{updated_body}\n\n{footer}".strip() + "\n"
    playbook_path = Path(memory_dir) / "sinain-playbook.md"
    playbook_path.write_text(new_playbook, encoding="utf-8")

    # Execute graph operations
    graph_ops = result.get("graphOps", [])
    digest_ts = digest.get("ts", datetime.now(timezone.utc).isoformat())
    graph_stats = _execute_graph_ops(db_path, graph_ops, digest_ts)

    # Append digest to session-digests.jsonl
    digests_path = Path(memory_dir) / "session-digests.jsonl"
    with open(digests_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(digest, ensure_ascii=False) + "\n")

    # Write integration log
    log_entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "_type": "integration",
        "changes": result.get("changes", {}),
        "graphStats": graph_stats,
        "digestEntities": digest_entities,
        "archivePath": archive_path,
        "playbookLines": len(new_playbook.splitlines()),
    }
    log_dir = Path(memory_dir) / "playbook-logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    log_file = log_dir / f"{today}.jsonl"
    with open(log_file, "a", encoding="utf-8") as f:
        f.write(json.dumps(log_entry, ensure_ascii=False) + "\n")

    output_json({
        "status": "ok",
        "changes": result.get("changes", {}),
        "graphStats": graph_stats,
        "playbookLines": len(new_playbook.splitlines()),
    })


if __name__ == "__main__":
    main()
