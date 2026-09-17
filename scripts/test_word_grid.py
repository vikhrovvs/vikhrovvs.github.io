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
    solver_directory = str(SOLVER_PATH.parent)
    if solver_directory not in sys.path:
        sys.path.insert(0, solver_directory)
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
    assert result["complexity"]["minimum"] <= result["complexity"]["average"]
    for item in result["words"]:
        path = item["path"]
        assert len(path) == len(set(path)) == len(item["word"])
        assert "".join(result["board"][cell] for cell in path) == item["word"]
        assert item["complexity"]["score"] >= 0
        assert all(
            solver.NEIGHBOUR_MASKS[first] & (1 << second)
            for first, second in zip(path, path[1:])
        )
    return result


def main() -> None:
    solver = load_solver()

    sample_words = "кино\nнота\nморе\nслед\nугол\nёж"
    sample_solution = assert_solution(solver, sample_words)
    manual_board = "\n".join(
        "".join(sample_solution["board"][start:start + 4])
        for start in range(0, 16, 4)
    )
    evaluated = solver.evaluate_board(manual_board, sample_words)
    assert evaluated["status"] == "evaluated"
    assert evaluated["board"] == sample_solution["board"]
    assert evaluated["complexity"] == sample_solution["complexity"]
    assert solver.evaluate_board("коротко", sample_words)["status"] == "invalid"
    assert solver.evaluate_board(manual_board, "несуществующее")["status"] == "not_solution"
    nested = assert_solution(solver, "скотина\nкот\nток")
    assert nested["stats"]["removed_words"] == 2
    assert_solution(solver, "топот\nпотоп")
    repeated_letters = assert_solution(solver, "око\nлоб")
    assert repeated_letters["stats"]["minimum_cells"] == 5
    assert repeated_letters["stats"]["unique_letters"] == 4

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

    straight = solver._path_complexity([0, 1, 2, 3])
    assert straight == {
        "score": 0.0,
        "turns": 0,
        "direction_types": 1,
        "mix_bonus": 0,
        "diagonal_steps": 0,
    }
    mixed = solver._path_complexity([0, 1, 6])
    assert mixed == {
        "score": 1.25,
        "turns": 1,
        "direction_types": 2,
        "mix_bonus": 1,
        "diagonal_steps": 1,
    }
    assert solver._median_from_counts(solver.Counter({0.0: 2, 2.0: 1}), 3) == 0
    assert solver._median_from_counts(solver.Counter({0.0: 1, 2.0: 1}), 2) == 1

    multi_path_board = [""] * 16
    for cell, letter in {0: "а", 1: "б", 2: "в", 4: "б", 5: "в"}.items():
        multi_path_board[cell] = letter
    easiest = solver._solution_payload(tuple(multi_path_board), ["абв"])
    assert easiest["words"][0]["path"] == [0, 1, 2]
    assert easiest["words"][0]["complexity"]["score"] == 0

    updates: list[str] = []
    sparse = solver.enumerate_solutions("а", 5, 100, 10, updates.append, 2)
    assert sparse["status"] == "complete" and sparse["exact"] is True
    assert sparse["count"] == sparse["stored_count"] == 3
    assert sparse["top_count"] == len(sparse["top_solutions"]) == 2
    assert sparse["average_benchmarks"]["bottom_count"] == 3
    streamed = [json.loads(update) for update in updates]
    assert [update["count"] for update in streamed] == [1, 2, 3]
    assert all(sum(bool(letter) for letter in update["solution"]["board"]) == 1 for update in streamed)

    # The two path directions of the repeated-letter word produce the same
    # visible board and must not be counted separately.
    repeated = solver.enumerate_solutions("аа", 5, 100, 10)
    assert repeated["status"] == "complete" and repeated["count"] == 8

    ranking_updates: list[str] = []
    ranked = solver.enumerate_solutions("abcd", 5, 1000, 1, ranking_updates.append)
    ranking_events = [json.loads(update) for update in ranking_updates]
    first_rank = ranking_events[0]["solution"]["complexity"]["minimum"]
    assert ranked["status"] == "complete" and ranked["count"] == 221
    assert ranked["top_count"] == len(ranked["top_solutions"]) == 100
    ranks = [
        (solution["complexity"]["minimum"], solution["complexity"]["average"])
        for solution in ranked["top_solutions"]
    ]
    assert ranks == sorted(ranks, reverse=True)
    assert ranked["top_solutions"][0]["board"] == ranked["best_solution"]["board"]
    benchmarks = ranked["average_benchmarks"]
    assert benchmarks["sample_count"] == 221 and benchmarks["bottom_count"] == 100
    assert benchmarks["bottom_100_average"] <= benchmarks["median"] <= benchmarks["best"]
    assert ranked["best_solution"]["complexity"]["minimum"] > first_rank
    assert any(update["event"] == "best" for update in ranking_events)

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
    assert limited["top_count"] == len(limited["top_solutions"]) == 2
    assert limited["best_solution"]["complexity"]["minimum"] >= 0
    assert len(full_board_updates) == 2
    assert all(
        all(json.loads(update)["solution"]["board"])
        for update in full_board_updates
    )

    # More than 16 requested letters triggers the automatic fallback.  The
    # first feasible candidate has 16 of the 17 words, which proves optimality.
    selection_updates: list[str] = []
    selected = solver.maximise_words_and_enumerate(
        "\n".join("abcdefghijklmnopq"),
        5,
        1,
        1,
        selection_updates.append,
        1,
    )
    assert selected["count"] == 1 and selected["word_selection"]["maximum_proven"] is True
    assert selected["word_selection"]["input_count"] == 17
    assert selected["word_selection"]["selected_count"] == 16
    assert len(selected["word_selection"]["omitted_words"]) == 1
    selection_events = [json.loads(update)["event"] for update in selection_updates]
    assert "selection-progress" in selection_events
    assert "selection" in selection_events
    assert "solution" in selection_events

    # With 16 mandatory letters x gets exactly one cell.  Nine different
    # leaves cannot all touch it because a king-grid cell has at most eight
    # neighbours; removing one word makes the remaining 14-word set feasible.
    maximum_star = solver.maximise_words_and_enumerate(
        "\n".join([
            *("x" + letter for letter in "abcdefghi"),
            *"jklmno",
        ]),
        5,
        1,
        1,
        top_limit=1,
    )
    assert maximum_star["word_selection"]["selected_count"] == 14, maximum_star
    assert maximum_star["word_selection"]["maximum_proven"] is True

    empty_maximum = solver.maximise_words_and_enumerate("abcdefghijklmnopq", 1)
    assert empty_maximum["status"] == "unsatisfiable"
    assert empty_maximum["word_selection"]["selected_count"] == 0

    # Real 12-word inputs that previously found nothing within 20 seconds.
    regression_cases = [
        (
            "барий\nбор\nборий\nбром\nйод\nрадий\nрадон\nродий\nуран\nхлор\nцезий\nцерий",
            8,
        ),
        (
            "алжир\nанкара\nберлин\nкаир\nлима\nманила\nпариж\nпекин\nрабат\nрига\nрим\nтирана",
            2,
        ),
    ]
    for words, expected_count in regression_cases:
        result = solver.enumerate_solutions(words, 2, 100, 1, top_limit=10)
        assert result["status"] == "complete", result
        assert result["count"] == expected_count
        assert result["stats"]["search_plans"] > 1
    print("OK: word-grid solver cases passed")


if __name__ == "__main__":
    main()
