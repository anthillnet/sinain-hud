"""Tests for playbook_curator.py: extract_header_footer() and reassemble_playbook()."""

from playbook_curator import extract_header_footer, reassemble_playbook


class TestExtractHeaderFooter:
    def test_standard_playbook(self):
        playbook = (
            "<!-- mining-index: 2026-02-21 -->\n"
            "# Playbook\n"
            "- Pattern 1\n"
            "- Pattern 2\n"
            "<!-- effectiveness: rate=0.63 -->\n"
        )
        header, body, footer = extract_header_footer(playbook)
        assert "mining-index" in header
        assert "# Playbook" in body
        assert "- Pattern 1" in body
        assert "effectiveness" in footer

    def test_no_header(self):
        playbook = "# Playbook\n- Pattern 1\n<!-- effectiveness: rate=0.5 -->\n"
        header, body, footer = extract_header_footer(playbook)
        assert header == ""
        assert "# Playbook" in body
        assert "effectiveness" in footer

    def test_no_footer(self):
        playbook = "<!-- mining-index: 2026-02-21 -->\n# Playbook\n- Pattern 1\n"
        header, body, footer = extract_header_footer(playbook)
        assert "mining-index" in header
        assert "# Playbook" in body
        assert footer == ""

    def test_empty_playbook(self):
        header, body, footer = extract_header_footer("")
        assert header == ""
        assert body == ""
        assert footer == ""

    def test_body_lines_exclude_comments(self):
        playbook = (
            "<!-- mining-index: 2026-02-21 -->\n"
            "line1\nline2\nline3\n"
            "<!-- effectiveness: rate=0.5 -->\n"
        )
        header, body, footer = extract_header_footer(playbook)
        body_lines = [l for l in body.strip().splitlines() if l.strip()]
        assert len(body_lines) == 3


class TestReassemblePlaybook:
    def test_standard_reassembly(self):
        result = reassemble_playbook(
            "<!-- mining-index: 2026-02-21 -->",
            "# Playbook\n- Pattern 1",
            "<!-- effectiveness: rate=0.5 -->",
        )
        assert "mining-index" in result
        assert "# Playbook" in result
        assert "effectiveness" in result
        assert result.endswith("\n")

    def test_body_limit_enforced(self):
        body_lines = [f"- Pattern {i}" for i in range(60)]
        body = "\n".join(body_lines)
        result = reassemble_playbook("", body, "")
        # Count non-empty lines in body section
        result_body_lines = [l for l in result.strip().splitlines() if l.strip()]
        assert len(result_body_lines) <= 50

    def test_empty_parts_handled(self):
        result = reassemble_playbook("", "body content", "")
        assert "body content" in result
        assert result.endswith("\n")

    def test_all_parts_empty(self):
        result = reassemble_playbook("", "", "")
        assert result == "\n"

    def test_50_lines_exactly(self):
        body_lines = [f"- Pattern {i}" for i in range(50)]
        body = "\n".join(body_lines)
        result = reassemble_playbook("<!-- header -->", body, "<!-- footer -->")
        # Should not truncate — 50 is exactly the limit
        assert "Pattern 49" in result

    def test_51_lines_truncated(self):
        body_lines = [f"- Pattern {i}" for i in range(51)]
        body = "\n".join(body_lines)
        result = reassemble_playbook("<!-- header -->", body, "<!-- footer -->")
        # Line 51 (Pattern 50) should be cut
        assert "Pattern 50" not in result
        assert "Pattern 49" in result
