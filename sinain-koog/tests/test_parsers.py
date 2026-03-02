"""Tests for common.py parser functions: parse_module_stack, parse_mining_index, parse_effectiveness."""

from common import parse_module_stack, parse_mining_index, parse_effectiveness


class TestParseModuleStack:
    def test_standard_stack(self):
        text = "<!-- module-stack: react-native-dev(85), ocr-pipeline(70) -->\nplaybook body"
        result = parse_module_stack(text)
        assert len(result) == 2
        assert result[0] == {"id": "react-native-dev", "priority": 85}
        assert result[1] == {"id": "ocr-pipeline", "priority": 70}

    def test_sorted_by_priority_desc(self):
        text = "<!-- module-stack: low(10), high(90), mid(50) -->"
        result = parse_module_stack(text)
        assert result[0]["id"] == "high"
        assert result[1]["id"] == "mid"
        assert result[2]["id"] == "low"

    def test_single_module(self):
        text = "<!-- module-stack: only-one(42) -->"
        result = parse_module_stack(text)
        assert len(result) == 1
        assert result[0] == {"id": "only-one", "priority": 42}

    def test_no_priority_parentheses(self):
        text = "<!-- module-stack: bare-module -->"
        result = parse_module_stack(text)
        assert len(result) == 1
        assert result[0] == {"id": "bare-module", "priority": 0}

    def test_absent_comment(self):
        text = "Just a regular playbook with no module-stack comment"
        assert parse_module_stack(text) == []

    def test_empty_stack(self):
        text = "<!-- module-stack: -->"
        assert parse_module_stack(text) == []


class TestParseMiningIndex:
    def test_standard_index(self):
        text = "<!-- mining-index: 2026-02-21,2026-02-20,2026-02-19 -->"
        result = parse_mining_index(text)
        assert result == ["2026-02-21", "2026-02-20", "2026-02-19"]

    def test_single_date(self):
        text = "<!-- mining-index: 2026-02-21 -->"
        result = parse_mining_index(text)
        assert result == ["2026-02-21"]

    def test_empty_index(self):
        text = "<!-- mining-index: -->"
        result = parse_mining_index(text)
        assert result == []

    def test_absent_comment(self):
        text = "No mining index here"
        assert parse_mining_index(text) == []

    def test_extra_whitespace(self):
        text = "<!-- mining-index: 2026-02-21 , 2026-02-20 -->"
        result = parse_mining_index(text)
        assert result == ["2026-02-21", "2026-02-20"]


class TestParseEffectiveness:
    def test_standard_metrics(self):
        text = "<!-- effectiveness: outputs=8,positive=5,negative=1,neutral=2,rate=0.63,updated=2026-02-21 -->"
        result = parse_effectiveness(text)
        assert result is not None
        assert result["outputs"] == 8
        assert result["positive"] == 5
        assert result["rate"] == 0.63
        assert result["updated"] == "2026-02-21"

    def test_absent_comment(self):
        assert parse_effectiveness("No effectiveness comment") is None

    def test_integer_conversion(self):
        text = "<!-- effectiveness: outputs=10 -->"
        result = parse_effectiveness(text)
        assert result["outputs"] == 10
        assert isinstance(result["outputs"], int)

    def test_float_conversion(self):
        text = "<!-- effectiveness: rate=0.75 -->"
        result = parse_effectiveness(text)
        assert result["rate"] == 0.75
        assert isinstance(result["rate"], float)

    def test_string_value(self):
        text = "<!-- effectiveness: updated=2026-02-21 -->"
        result = parse_effectiveness(text)
        assert result["updated"] == "2026-02-21"
