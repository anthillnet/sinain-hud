#!/usr/bin/env python3
"""Triple Extractor — 3-tier extraction from sinain data into EAV triples.

Tier 1: JSON direct (~70%) — structured data maps directly to triples.
Tier 2: Regex + validate (~20%) — semi-structured text (playbooks, patterns.md).
Tier 3: LLM fallback (~10%) — free-form text where regex fails.

Usage:
    from triple_extractor import TripleExtractor
    extractor = TripleExtractor(store)
    triples = extractor.extract_signal(signal_data, tick_ts)
"""

import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from triplestore import TripleStore


@dataclass
class Triple:
    """A single entity-attribute-value triple to be asserted."""
    entity_id: str
    attribute: str
    value: str
    value_type: str = "string"


def _make_slug(text: str) -> str:
    """Convert text to a lowercase hyphen-separated slug.

    >>> _make_slug("Frame Batching Improves OCR")
    'frame-batching-improves-ocr'
    """
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower().strip())
    return slug.strip("-")[:80]  # cap length


class TripleExtractor:
    """Extracts EAV triples from various sinain data sources."""

    def __init__(self, store: "TripleStore") -> None:
        self.store = store
        self._vocab_cache: list[tuple[str, str]] | None = None

    # ----- Tier 1: JSON direct extraction -----

    def extract_signal(self, signal_data: dict, tick_ts: str) -> list[Triple]:
        """Extract triples from a signal analysis result (Tier 1).

        Creates signal:{tick_ts} entity + concept refs for signals.
        """
        triples: list[Triple] = []
        entity_id = f"signal:{tick_ts}"

        # Core signal attributes
        if "sessionSummary" in signal_data:
            triples.append(Triple(entity_id, "summary", str(signal_data["sessionSummary"])))
        if "idle" in signal_data:
            triples.append(Triple(entity_id, "idle", str(signal_data["idle"]).lower()))

        # Individual signals
        for i, sig in enumerate(signal_data.get("signals", [])):
            desc = sig.get("description", "")
            priority = sig.get("priority", "medium")
            if desc:
                triples.append(Triple(entity_id, "description", desc))
                triples.append(Triple(entity_id, "priority", priority))
                # Extract concepts from signal description
                for concept_triple in self.extract_concepts(desc):
                    triples.append(concept_triple)
                    if concept_triple.entity_id.startswith("concept:"):
                        triples.append(Triple(
                            entity_id, "related_to", concept_triple.entity_id, "ref"
                        ))

        # Recommended action
        action = signal_data.get("recommendedAction")
        if action and isinstance(action, dict):
            triples.append(Triple(entity_id, "action", action.get("action", "")))
            if "task" in action:
                triples.append(Triple(entity_id, "action_task", action["task"]))
            if "confidence" in action:
                triples.append(Triple(entity_id, "action_confidence", str(action["confidence"])))

        # Playbook changes
        changes = (signal_data.get("playbookChanges") or {}).get("changes", {})
        for added in changes.get("added", []):
            slug = _make_slug(added)
            if slug:
                pattern_id = f"pattern:{slug}"
                triples.append(Triple(pattern_id, "text", added))
                triples.append(Triple(pattern_id, "source", "signal_analyzer"))
                triples.append(Triple(entity_id, "added_pattern", pattern_id, "ref"))

        # Output
        output = signal_data.get("output", {})
        if isinstance(output, dict):
            if output.get("suggestion"):
                triples.append(Triple(entity_id, "suggestion", output["suggestion"]))
            if output.get("insight"):
                triples.append(Triple(entity_id, "insight", output["insight"]))

        return triples

    def extract_session(self, session_data: dict) -> list[Triple]:
        """Extract triples from a session summary (Tier 1).

        Creates session:{ts} entity with summary, tool refs, etc.
        """
        triples: list[Triple] = []
        ts = session_data.get("ts", session_data.get("timestamp", "unknown"))
        entity_id = f"session:{ts}"

        if "summary" in session_data:
            triples.append(Triple(entity_id, "summary", session_data["summary"]))
        if "sessionSummary" in session_data:
            triples.append(Triple(entity_id, "summary", session_data["sessionSummary"]))

        # Tool usage
        for tool in session_data.get("toolsUsed", []):
            tool_name = tool if isinstance(tool, str) else tool.get("name", "")
            if tool_name:
                tool_id = f"tool:{_make_slug(tool_name)}"
                triples.append(Triple(tool_id, "name", tool_name))
                triples.append(Triple(entity_id, "used_tool", tool_id, "ref"))

        # Duration
        if "durationMs" in session_data:
            triples.append(Triple(entity_id, "duration_ms", str(session_data["durationMs"])))

        # Extract concepts from summary
        summary_text = session_data.get("summary", session_data.get("sessionSummary", ""))
        if summary_text:
            for concept_triple in self.extract_concepts(summary_text):
                triples.append(concept_triple)
                if concept_triple.entity_id.startswith("concept:"):
                    triples.append(Triple(
                        entity_id, "related_to", concept_triple.entity_id, "ref"
                    ))

        return triples

    def extract_mining(self, mining_data: dict) -> list[Triple]:
        """Extract triples from memory mining results (Tier 1).

        New patterns → pattern:{slug} entities.
        """
        triples: list[Triple] = []

        for pattern_text in mining_data.get("newPatterns", []):
            slug = _make_slug(pattern_text)
            if not slug:
                continue
            pattern_id = f"pattern:{slug}"
            triples.append(Triple(pattern_id, "text", pattern_text))
            triples.append(Triple(pattern_id, "source", "memory_miner"))
            # Extract concepts
            for ct in self.extract_concepts(pattern_text):
                triples.append(ct)
                if ct.entity_id.startswith("concept:"):
                    triples.append(Triple(pattern_id, "related_to", ct.entity_id, "ref"))

        for pref in mining_data.get("preferences", []):
            slug = _make_slug(pref)
            if slug:
                pref_id = f"pattern:{slug}"
                triples.append(Triple(pref_id, "text", pref))
                triples.append(Triple(pref_id, "source", "memory_miner"))
                triples.append(Triple(pref_id, "pattern_type", "preference"))

        for contradiction in mining_data.get("contradictions", []):
            slug = _make_slug(contradiction)
            if slug:
                c_id = f"pattern:{slug}"
                triples.append(Triple(c_id, "text", contradiction))
                triples.append(Triple(c_id, "source", "memory_miner"))
                triples.append(Triple(c_id, "pattern_type", "contradiction"))

        return triples

    # ----- Tier 2: Regex extraction -----

    def extract_playbook(self, playbook_text: str) -> list[Triple]:
        """Extract triples from playbook markdown (Tier 2: regex).

        Pattern: ^- text (score: N.N)?
        Falls back to Tier 3 if <3 patterns extracted from non-empty input.
        """
        triples: list[Triple] = []
        pattern_re = re.compile(r"^-\s+(.+?)(?:\s*\(score:\s*([\d.]+)\))?\s*$", re.MULTILINE)

        for match in pattern_re.finditer(playbook_text):
            text = match.group(1).strip()
            score = match.group(2)

            # Skip HTML comments and metadata
            if text.startswith("<!--") or text.startswith("[since:"):
                continue

            slug = _make_slug(text)
            if not slug:
                continue

            pattern_id = f"pattern:{slug}"
            triples.append(Triple(pattern_id, "text", text))
            triples.append(Triple(pattern_id, "source", "playbook"))
            if score:
                triples.append(Triple(pattern_id, "score", score))

            # Extract concepts from pattern text
            for ct in self.extract_concepts(text):
                triples.append(ct)
                if ct.entity_id.startswith("concept:"):
                    triples.append(Triple(pattern_id, "related_to", ct.entity_id, "ref"))

        # Tier 3 fallback: if we got <3 patterns from non-trivial input
        non_comment = re.sub(r"<!--.*?-->", "", playbook_text, flags=re.DOTALL).strip()
        if len(non_comment) > 100 and sum(1 for t in triples if t.attribute == "text") < 3:
            tier3 = self._extract_patterns_llm(playbook_text)
            triples.extend(tier3)

        return triples

    def extract_module(
        self, module_id: str, manifest: dict, patterns_text: str,
        guidance_text: str = "",
    ) -> list[Triple]:
        """Extract triples from a module's manifest (Tier 1) + patterns.md + guidance.md (Tier 2).

        Creates module:{id} entity + pattern entities from patterns.md
        + guidance entities from guidance.md.
        """
        triples: list[Triple] = []
        entity_id = f"module:{module_id}"

        # Tier 1: manifest fields
        triples.append(Triple(entity_id, "name", manifest.get("name", module_id)))
        if "description" in manifest:
            triples.append(Triple(entity_id, "description", manifest["description"]))
        if "version" in manifest:
            triples.append(Triple(entity_id, "version", manifest["version"]))

        # Tier 2: extract patterns from patterns.md
        if patterns_text:
            pattern_triples = self.extract_playbook(patterns_text)
            for pt in pattern_triples:
                triples.append(pt)
                # Link patterns to module
                if pt.attribute == "text" and pt.entity_id.startswith("pattern:"):
                    triples.append(Triple(pt.entity_id, "belongs_to", entity_id, "ref"))

        # Tier 2b: extract guidance items from guidance.md
        if guidance_text:
            guidance_triples = self.extract_playbook(guidance_text)
            for gt in guidance_triples:
                # Remap pattern: → guidance: entity prefix
                if gt.entity_id.startswith("pattern:"):
                    gt = Triple(
                        gt.entity_id.replace("pattern:", "guidance:", 1),
                        gt.attribute, gt.value, gt.value_type,
                    )
                triples.append(gt)
                if gt.attribute == "text" and gt.entity_id.startswith("guidance:"):
                    triples.append(Triple(gt.entity_id, "type", "guidance"))
                    triples.append(Triple(gt.entity_id, "belongs_to", entity_id, "ref"))

        return triples

    # ----- Concept extraction (3-tier) -----

    def extract_concepts(self, text: str) -> list[Triple]:
        """Extract concept entities from text using 3-tier strategy.

        Tier 1: Match against vocabulary cache from store.
        Tier 2: Regex noun-phrase extraction.
        Tier 3: LLM fallback (only if tiers 1+2 yield nothing from substantial text).
        """
        concepts: set[str] = set()

        # Tier 1: vocabulary cache matching
        vocab = self._get_vocab_cache()
        text_lower = text.lower()
        for concept_name, concept_id in vocab:
            if concept_name in text_lower:
                concepts.add(concept_id)

        # Tier 2: regex noun-phrase extraction
        # Match capitalized multi-word phrases and technical terms
        noun_phrases = set()
        # Capitalized phrases (2+ words)
        for m in re.finditer(r"\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b", text):
            noun_phrases.add(m.group(1))
        # Technical terms: word-word patterns (e.g., "frame-batching", "OCR-pipeline")
        for m in re.finditer(r"\b([a-zA-Z]+-[a-zA-Z]+(?:-[a-zA-Z]+)*)\b", text):
            term = m.group(1)
            if len(term) > 4:  # skip short terms like "is-a"
                noun_phrases.add(term)
        # ALL-CAPS acronyms (2+ chars)
        for m in re.finditer(r"\b([A-Z]{2,})\b", text):
            noun_phrases.add(m.group(1))

        # Convert noun phrases to concept triples
        triples: list[Triple] = []
        for concept_id in concepts:
            # Already exists in store — just reference it
            pass  # caller will create ref triples

        for phrase in noun_phrases:
            slug = _make_slug(phrase)
            if not slug or len(slug) < 2:
                continue
            concept_id = f"concept:{slug}"
            if concept_id not in concepts:
                concepts.add(concept_id)
                triples.append(Triple(concept_id, "name", phrase))

        # Return known concepts as triples too (for caller to create refs)
        for cid in concepts:
            if not any(t.entity_id == cid for t in triples):
                # Concept from vocab cache — ensure it's in the output
                triples.append(Triple(cid, "name", cid.split(":", 1)[1] if ":" in cid else cid))

        # Tier 3: LLM fallback only if we found nothing from substantial text
        if not concepts and len(text) > 100:
            tier3 = self._extract_concepts_llm(text)
            triples.extend(tier3)

        return triples

    def _get_vocab_cache(self) -> list[tuple[str, str]]:
        """Load vocabulary from store: all (name, entity_id) for concept: entities."""
        if self._vocab_cache is not None:
            return self._vocab_cache
        try:
            results = self.store.entities_with_attr("name")
            self._vocab_cache = [
                (val.lower(), eid)
                for eid, val in results
                if eid.startswith("concept:")
            ]
        except Exception:
            self._vocab_cache = []
        return self._vocab_cache

    # ----- Tier 3: LLM fallback -----

    def _extract_patterns_llm(self, text: str) -> list[Triple]:
        """Use LLM to extract patterns from unstructured text."""
        try:
            from common import call_llm_with_fallback, extract_json
        except ImportError:
            return []

        system = (
            "Extract actionable patterns from this text. Return JSON: "
            '{"patterns": ["pattern 1", "pattern 2", ...]}'
        )
        try:
            raw = call_llm_with_fallback(system, text[:4000], script="triple_extractor")
            data = extract_json(raw)
            triples: list[Triple] = []
            for p in data.get("patterns", []):
                slug = _make_slug(p)
                if slug:
                    pid = f"pattern:{slug}"
                    triples.append(Triple(pid, "text", p))
                    triples.append(Triple(pid, "source", "llm_extraction"))
            return triples
        except Exception as e:
            print(f"[warn] Tier 3 pattern extraction failed: {e}", file=sys.stderr)
            return []

    def _extract_concepts_llm(self, text: str) -> list[Triple]:
        """Use LLM to extract concepts from text."""
        try:
            from common import call_llm_with_fallback, extract_json
        except ImportError:
            return []

        system = (
            "Extract key concepts/entities from this text. Return JSON: "
            '{"concepts": ["concept 1", "concept 2", ...]}'
        )
        try:
            raw = call_llm_with_fallback(system, text[:4000], script="triple_extractor")
            data = extract_json(raw)
            triples: list[Triple] = []
            for c in data.get("concepts", []):
                slug = _make_slug(c)
                if slug:
                    cid = f"concept:{slug}"
                    triples.append(Triple(cid, "name", c))
            return triples
        except Exception as e:
            print(f"[warn] Tier 3 concept extraction failed: {e}", file=sys.stderr)
            return []
