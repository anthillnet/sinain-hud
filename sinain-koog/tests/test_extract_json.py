"""Tests for common.extract_json() — all three extraction stages + truncation repair."""

import pytest
from common import extract_json


class TestStage1DirectParse:
    def test_clean_object(self):
        result = extract_json('{"signals": [], "idle": true}')
        assert result["signals"] == []
        assert result["idle"] is True

    def test_clean_array(self):
        result = extract_json('[{"a": 1}, {"b": 2}]')
        assert len(result) == 2

    def test_whitespace_padded(self):
        result = extract_json('  \n  {"key": "value"}  \n  ')
        assert result["key"] == "value"

    def test_unicode(self):
        result = extract_json('{"msg": "привет мир"}')
        assert result["msg"] == "привет мир"


class TestStage2MarkdownFences:
    def test_fenced_json(self):
        result = extract_json('```json\n{"signals": ["x"], "idle": false}\n```')
        assert result["signals"] == ["x"]

    def test_fenced_no_lang_tag(self):
        result = extract_json('```\n{"findings": "test"}\n```')
        assert result["findings"] == "test"

    def test_text_before_fence(self):
        result = extract_json('Here is the result:\n```json\n{"skip": true}\n```')
        assert result["skip"] is True

    def test_text_after_fence(self):
        result = extract_json('```json\n{"skip": false}\n```\nHope this helps!')
        assert result["skip"] is False

    def test_text_before_and_after_fence(self):
        result = extract_json(
            'I analyzed it.\n```json\n{"curateDirective": "normal"}\n```\nLet me know.'
        )
        assert result["curateDirective"] == "normal"


class TestStage3BalancedBrace:
    def test_prose_then_json(self):
        result = extract_json('The analysis result is: {"signals": ["a"], "idle": true}')
        assert result["signals"] == ["a"]

    def test_json_then_prose(self):
        result = extract_json('{"findings": "test"} That is all.')
        assert result["findings"] == "test"

    def test_nested_braces(self):
        result = extract_json('{"outer": {"inner": {"deep": 1}}, "key": "val"}')
        assert result["outer"]["inner"]["deep"] == 1

    def test_strings_with_braces(self):
        result = extract_json('{"msg": "use {braces} like this", "ok": true}')
        assert result["msg"] == "use {braces} like this"

    def test_prose_embedded_array(self):
        # Balanced-brace scanner tries {} before [], so it finds the first object
        result = extract_json('Result: [{"a": 1}, {"b": 2}]')
        assert isinstance(result, (dict, list))

    def test_escaped_quotes_in_strings(self):
        result = extract_json(r'{"msg": "he said \"hello\"", "ok": true}')
        assert result["ok"] is True


class TestStage4TruncationRepair:
    def test_missing_closing_brace(self):
        result = extract_json('{"signals": ["a", "b"], "idle": true, "extra": "val')
        assert result["signals"] == ["a", "b"]

    def test_missing_two_closing_braces(self):
        result = extract_json('{"outer": {"inner": "val"')
        assert result["outer"]["inner"] == "val"

    def test_truncated_array_in_object(self):
        result = extract_json('{"items": [1, 2, 3')
        assert result["items"] == [1, 2, 3]

    def test_trailing_comma(self):
        result = extract_json('{"a": 1, "b": 2,')
        assert result["a"] == 1

    def test_mid_key_truncation(self):
        result = extract_json('{"valid": 1, "partial_ke')
        assert result["valid"] == 1

    def test_prose_plus_truncated(self):
        result = extract_json(
            'Here is the result: {"findings": "some text", "patterns": ["p1"'
        )
        assert result["findings"] == "some text"

    def test_truncated_simple_object(self):
        result = extract_json('{"unclosed": "brace"')
        assert result["unclosed"] == "brace"


class TestFailureCases:
    def test_no_json_at_all(self):
        with pytest.raises(ValueError):
            extract_json("This is just plain text with no JSON.")

    def test_empty_string(self):
        with pytest.raises(ValueError):
            extract_json("")

    def test_no_brackets(self):
        with pytest.raises(ValueError):
            extract_json("just some random text without any brackets")

    def test_only_whitespace(self):
        with pytest.raises(ValueError):
            extract_json("   \n\n  ")
