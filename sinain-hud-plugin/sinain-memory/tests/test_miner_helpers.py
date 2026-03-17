"""Tests for memory_miner.py: get_unmined_files() and update_mining_index()."""

from pathlib import Path
from memory_miner import get_unmined_files, update_mining_index
from common import parse_mining_index


class TestGetUnminedFiles:
    def test_all_mined(self, tmp_memory_dir):
        memory_dir = str(tmp_memory_dir)
        mined = ["2026-02-21", "2026-02-20", "2026-02-19"]
        result = get_unmined_files(memory_dir, mined)
        assert result == []

    def test_some_unmined(self, tmp_memory_dir):
        memory_dir = str(tmp_memory_dir)
        mined = ["2026-02-21"]
        result = get_unmined_files(memory_dir, mined)
        basenames = [Path(f).stem for f in result]
        assert "2026-02-20" in basenames
        assert "2026-02-19" in basenames
        assert "2026-02-21" not in basenames

    def test_none_mined(self, tmp_memory_dir):
        memory_dir = str(tmp_memory_dir)
        result = get_unmined_files(memory_dir, [])
        assert len(result) == 3  # all 3 daily files

    def test_no_daily_files(self, tmp_path):
        empty_memory = tmp_path / "empty-memory"
        empty_memory.mkdir()
        result = get_unmined_files(str(empty_memory), [])
        assert result == []


class TestUpdateMiningIndex:
    def test_adds_new_dates(self, tmp_memory_dir):
        memory_dir = str(tmp_memory_dir)
        playbook = (tmp_memory_dir / "sinain-playbook.md").read_text()
        update_mining_index(memory_dir, playbook, ["2026-02-22"])

        updated = (tmp_memory_dir / "sinain-playbook.md").read_text()
        index = parse_mining_index(updated)
        assert "2026-02-22" in index

    def test_deduplicates(self, tmp_memory_dir):
        memory_dir = str(tmp_memory_dir)
        playbook = (tmp_memory_dir / "sinain-playbook.md").read_text()
        # 2026-02-21 is already in index
        update_mining_index(memory_dir, playbook, ["2026-02-21"])

        updated = (tmp_memory_dir / "sinain-playbook.md").read_text()
        index = parse_mining_index(updated)
        assert index.count("2026-02-21") == 1

    def test_creates_playbook_if_missing(self, tmp_path):
        memory_dir = str(tmp_path)
        update_mining_index(memory_dir, "", ["2026-02-25"])

        playbook = (tmp_path / "sinain-playbook.md").read_text()
        assert "mining-index:" in playbook
        assert "2026-02-25" in playbook

    def test_sorted_descending(self, tmp_memory_dir):
        memory_dir = str(tmp_memory_dir)
        playbook = (tmp_memory_dir / "sinain-playbook.md").read_text()
        update_mining_index(memory_dir, playbook, ["2026-02-22", "2026-02-23"])

        updated = (tmp_memory_dir / "sinain-playbook.md").read_text()
        index = parse_mining_index(updated)
        assert index == sorted(index, reverse=True)
