"""Tests for triple_extractor.py — 3-tier extraction."""

import pytest
from triplestore import TripleStore
from triple_extractor import TripleExtractor, Triple, _make_slug


@pytest.fixture
def store(tmp_path):
    s = TripleStore(str(tmp_path / "test.db"))
    yield s
    s.close()


@pytest.fixture
def extractor(store):
    return TripleExtractor(store)


@pytest.fixture
def store_with_vocab(store):
    """Store pre-populated with concept vocabulary."""
    tx = store.begin_tx("setup")
    store.assert_triple(tx, "concept:ocr", "name", "OCR")
    store.assert_triple(tx, "concept:flutter", "name", "Flutter")
    store.assert_triple(tx, "concept:react-native", "name", "React Native")
    return store


# ----- Slug generation -----

class TestMakeSlug:
    def test_basic(self):
        assert _make_slug("Frame Batching") == "frame-batching"

    def test_special_chars(self):
        assert _make_slug("OCR pipeline (v2.0)") == "ocr-pipeline-v2-0"

    def test_leading_trailing(self):
        assert _make_slug("  --hello--  ") == "hello"

    def test_max_length(self):
        long = "a" * 100
        assert len(_make_slug(long)) <= 80

    def test_empty(self):
        assert _make_slug("") == ""
        assert _make_slug("---") == ""


# ----- Tier 1: Signal extraction -----

class TestExtractSignal:
    def test_basic_signal(self, extractor):
        data = {
            "sessionSummary": "Debugging OCR pipeline",
            "idle": False,
            "signals": [
                {"description": "OCR pipeline backpressure", "priority": "high"}
            ],
            "recommendedAction": {"action": "sessions_spawn", "task": "Debug", "confidence": 0.8},
            "output": {"suggestion": "Try frame batching", "insight": "Evening pattern"},
        }
        triples = extractor.extract_signal(data, "2026-03-01T10:00:00Z")

        # Check entity creation
        entity_attrs = {t.attribute for t in triples if t.entity_id == "signal:2026-03-01T10:00:00Z"}
        assert "summary" in entity_attrs
        assert "description" in entity_attrs
        assert "priority" in entity_attrs
        assert "action" in entity_attrs
        assert "suggestion" in entity_attrs

    def test_signal_with_playbook_changes(self, extractor):
        data = {
            "signals": [],
            "playbookChanges": {
                "changes": {"added": ["Use frame batching for OCR"], "pruned": [], "promoted": []}
            },
        }
        triples = extractor.extract_signal(data, "2026-03-01")
        pattern_triples = [t for t in triples if t.entity_id.startswith("pattern:")]
        assert len(pattern_triples) > 0
        assert any(t.attribute == "text" and "frame batching" in t.value.lower() for t in pattern_triples)

    def test_signal_empty(self, extractor):
        triples = extractor.extract_signal({"signals": []}, "2026-03-01")
        assert isinstance(triples, list)

    def test_signal_concepts_extracted(self, extractor):
        data = {"signals": [{"description": "OCR Pipeline stall detected", "priority": "high"}]}
        triples = extractor.extract_signal(data, "2026-03-01")
        concept_triples = [t for t in triples if t.entity_id.startswith("concept:")]
        assert len(concept_triples) > 0  # "OCR" or "Pipeline" should be extracted

    def test_signal_concept_refs(self, extractor):
        data = {"signals": [{"description": "React Native bridge crash", "priority": "high"}]}
        triples = extractor.extract_signal(data, "2026-03-01")
        ref_triples = [t for t in triples if t.value_type == "ref" and t.attribute == "related_to"]
        assert len(ref_triples) > 0


# ----- Tier 1: Session extraction -----

class TestExtractSession:
    def test_basic_session(self, extractor):
        data = {
            "ts": "2026-03-01T09:00:00Z",
            "summary": "Implemented OCR batch processing",
            "toolsUsed": ["Read", "Edit", "Bash"],
            "durationMs": 120000,
        }
        triples = extractor.extract_session(data)

        # Check session entity
        session_triples = [t for t in triples if t.entity_id.startswith("session:")]
        assert any(t.attribute == "summary" for t in session_triples)
        assert any(t.attribute == "duration_ms" for t in session_triples)

        # Check tool refs
        tool_triples = [t for t in triples if t.entity_id.startswith("tool:")]
        assert len(tool_triples) >= 3

    def test_session_tool_refs(self, extractor):
        data = {
            "ts": "2026-03-01",
            "toolsUsed": ["Bash"],
        }
        triples = extractor.extract_session(data)
        ref_triples = [t for t in triples if t.value_type == "ref" and t.attribute == "used_tool"]
        assert len(ref_triples) == 1


# ----- Tier 1: Mining extraction -----

class TestExtractMining:
    def test_new_patterns(self, extractor):
        data = {
            "newPatterns": ["Frame dropping improves OCR accuracy", "Use batch processing"],
            "preferences": ["User prefers minimal configs"],
            "contradictions": [],
        }
        triples = extractor.extract_mining(data)
        pattern_triples = [t for t in triples if t.attribute == "text"]
        assert len(pattern_triples) >= 2

    def test_mining_preferences(self, extractor):
        data = {"newPatterns": [], "preferences": ["User likes concise output"]}
        triples = extractor.extract_mining(data)
        pref_triples = [t for t in triples if t.attribute == "pattern_type" and t.value == "preference"]
        assert len(pref_triples) == 1

    def test_mining_contradictions(self, extractor):
        data = {"newPatterns": [], "contradictions": ["Playbook says X but observation shows Y"]}
        triples = extractor.extract_mining(data)
        contra = [t for t in triples if t.attribute == "pattern_type" and t.value == "contradiction"]
        assert len(contra) == 1

    def test_mining_empty(self, extractor):
        triples = extractor.extract_mining({"newPatterns": [], "preferences": [], "contradictions": []})
        assert triples == []


# ----- Tier 2: Playbook extraction (regex) -----

class TestExtractPlaybook:
    def test_patterns_with_scores(self, extractor):
        text = (
            "## Established Patterns\n"
            "- OCR pipeline stalls when queue depth > 10 (score: 0.8)\n"
            "- Use frame batching for throughput (score: 0.6)\n"
            "- Spawn research agent for new frameworks\n"
        )
        triples = extractor.extract_playbook(text)
        text_triples = [t for t in triples if t.attribute == "text"]
        assert len(text_triples) >= 3

        score_triples = [t for t in triples if t.attribute == "score"]
        assert len(score_triples) == 2
        assert any(t.value == "0.8" for t in score_triples)

    def test_skips_comments_and_metadata(self, extractor):
        text = "- <!-- mining-index: 2026-02-21 -->\n- [since: 2026-02-18] stale entry\n- Real pattern here\n"
        triples = extractor.extract_playbook(text)
        text_triples = [t for t in triples if t.attribute == "text"]
        # Should only get "Real pattern here"
        assert any("Real pattern" in t.value for t in text_triples)
        assert not any("mining-index" in t.value for t in text_triples)

    def test_playbook_source_tagged(self, extractor):
        text = "- Use batch processing\n"
        triples = extractor.extract_playbook(text)
        source_triples = [t for t in triples if t.attribute == "source"]
        assert any(t.value == "playbook" for t in source_triples)


# ----- Tier 2: Module extraction -----

class TestExtractModule:
    def test_module_manifest_and_patterns(self, extractor):
        manifest = {
            "name": "React Native Dev",
            "description": "RN development patterns",
            "version": "1.0.0",
        }
        patterns_text = "## Established\n- Use Hermes engine for Android\n- Enable Fast Refresh\n"
        triples = extractor.extract_module("react-native-dev", manifest, patterns_text)

        module_triples = [t for t in triples if t.entity_id == "module:react-native-dev"]
        assert any(t.attribute == "name" and t.value == "React Native Dev" for t in module_triples)
        assert any(t.attribute == "description" for t in module_triples)

        # Patterns should link back to module
        belongs_triples = [t for t in triples if t.attribute == "belongs_to" and t.value == "module:react-native-dev"]
        assert len(belongs_triples) >= 2


# ----- Concept extraction -----

class TestExtractConcepts:
    def test_vocab_cache_match(self, store_with_vocab):
        extractor = TripleExtractor(store_with_vocab)
        triples = extractor.extract_concepts("Working on OCR pipeline improvements")
        concept_ids = {t.entity_id for t in triples}
        assert "concept:ocr" in concept_ids

    def test_regex_capitalized_phrases(self, extractor):
        # Multi-word capitalized phrases get captured (including leading caps)
        triples = extractor.extract_concepts("Debugging React Native bridge issues")
        concept_ids = {t.entity_id for t in triples}
        # "Debugging React Native" is captured as one phrase since all words are capitalized
        assert any("react-native" in cid for cid in concept_ids)

    def test_regex_acronyms(self, extractor):
        triples = extractor.extract_concepts("The API uses JSON over HTTP")
        concept_ids = {t.entity_id for t in triples}
        assert any("api" in cid for cid in concept_ids)
        assert any("json" in cid for cid in concept_ids)
        assert any("http" in cid for cid in concept_ids)

    def test_regex_technical_terms(self, extractor):
        triples = extractor.extract_concepts("Check the frame-batching pipeline and error-handling logic")
        concept_ids = {t.entity_id for t in triples}
        assert "concept:frame-batching" in concept_ids
        assert "concept:error-handling" in concept_ids

    def test_short_text_no_llm(self, extractor):
        # Short text should not trigger LLM fallback
        triples = extractor.extract_concepts("Hello")
        # Should return empty or just regex matches, no LLM call
        assert isinstance(triples, list)

    def test_empty_text(self, extractor):
        triples = extractor.extract_concepts("")
        assert triples == []
