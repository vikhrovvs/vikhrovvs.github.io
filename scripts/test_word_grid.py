#!/usr/bin/env python3
"""Dependency-free checks for the word-grid CSP solver."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
SOLVER_PATH = ROOT / "site" / "word-grid" / "solver.py"


def load_solver():
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("word_grid_solver", SOLVER_PATH)
    if spec is None or spec.loader is None:
        raise AssertionError("Could not load word-grid solver")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def assert_solution(solver, words: str) -> dict:
    result = solver.solve(words, time_limit_seconds=5)
    assert result["status"] == "solved", result
    assert len(result["board"]) == 16
    for item in result["words"]:
        path = item["path"]
        assert len(path) == len(set(path)) == len(item["word"])
        assert "".join(result["board"][cell] for cell in path) == item["word"]
        assert all(
            solver.NEIGHBOUR_MASKS[first] & (1 << second)
            for first, second in zip(path, path[1:])
        )
    return result


def main() -> None:
    solver = load_solver()

    assert_solution(solver, "кино\nнота\nморе\nслед\nугол\nёж")
    nested = assert_solution(solver, "скотина\nкот\nток")
    assert nested["stats"]["removed_words"] == 2
    assert_solution(solver, "топот\nпотоп")

    too_long = solver.solve("abcdefghijklmnopq")
    assert too_long["status"] == "unsatisfiable"

    too_many_letters = solver.solve("abcdefghijklmnop\nq")
    assert too_many_letters["status"] == "unsatisfiable"

    # All 16 letters need their own cell, leaving a single x cell.  That cell
    # cannot be adjacent to 15 distinct leaves in a grid with maximum degree 8.
    impossible_star = "\n".join("x" + letter for letter in "abcdefghijklmno")
    no_solution = solver.solve(impossible_star, time_limit_seconds=5)
    assert no_solution["status"] == "unsatisfiable", no_solution

    invalid = solver.solve("два слова")
    assert invalid["status"] == "invalid"

    updates: list[str] = []
    sparse = solver.enumerate_solutions("а", 5, 100, 10, updates.append)
    assert sparse["status"] == "complete" and sparse["exact"] is True
    assert sparse["count"] == sparse["stored_count"] == 3
    streamed = [json.loads(update) for update in updates]
    assert [update["count"] for update in streamed] == [1, 2, 3]
    assert all(sum(bool(letter) for letter in update["solution"]["board"]) == 1 for update in streamed)

    # The two path directions of the repeated-letter word produce the same
    # visible board and must not be counted separately.
    repeated = solver.enumerate_solutions("аа", 5, 100, 10)
    assert repeated["status"] == "complete" and repeated["count"] == 8

    full_board_updates: list[str] = []
    limited = solver.enumerate_solutions(
        "abcdefghijklmnop",
        5,
        2,
        2,
        full_board_updates.append,
    )
    assert limited["status"] == "partial" and limited["exact"] is False
    assert limited["count"] == 2 and limited["stop_reason"] == "limit"
    assert len(full_board_updates) == 2
    assert all(
        all(json.loads(update)["solution"]["board"])
        for update in full_board_updates
    )
    print("OK: word-grid solver cases passed")


if __name__ == "__main__":
    main()
