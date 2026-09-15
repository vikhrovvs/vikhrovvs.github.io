"""Public workflows for the 4 x 4 word-grid solver.

The implementation is split by responsibility:

* :mod:`grid_model` owns board geometry, input parsing, and cheap reductions;
* :mod:`csp` contains the exact constraint search;
* :mod:`complexity` recovers paths and scores their tangle;
* :mod:`subset_selection` generates maximum-cardinality word candidates.

This module keeps the stable Python and JSON APIs used by tests and Pyodide.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable
from heapq import heappush, heapreplace
import json
import time

from complexity import (
    _board_complexity,
    _find_easiest_word_path,
    _letter_positions,
    _path_complexity,
    _solution_payload,
)
from csp import WordGridCsp
from grid_model import (
    CELL_COUNT,
    MAX_ESSENTIAL_POSITIONS,
    NEIGHBOUR_MASKS,
    InputError,
    SearchTimedOut,
    _canonical_board,
    _essential_words,
    _necessary_cell_counts,
    _normalise_board,
    _normalise_words,
)
from subset_selection import _iter_candidate_subsets, _selection_metadata


DEFAULT_TIME_LIMIT_SECONDS = 20.0
MAX_TIME_LIMIT_SECONDS = 600.0
DEFAULT_DISPLAY_LIMIT = 200
DEFAULT_TOP_LIMIT = 100
DEFAULT_BOTTOM_LIMIT = 100
DEFAULT_MAX_UNIQUE_SOLUTIONS = 100_000


class SubsetSearchIncomplete(Exception):
    """Raised when a candidate exceeds a browser safety limit."""


def _prepare_problem(raw_words: str) -> tuple[dict | None, dict | None]:
    try:
        words = _normalise_words(raw_words)
    except InputError as error:
        return None, {"status": "invalid", "message": str(error)}

    longest = max(words, key=len)
    if len(longest) > CELL_COUNT:
        return None, {
            "status": "unsatisfiable",
            "message": f"Слово «{longest}» длиннее 16 букв, поэтому не помещается без повторной клетки.",
        }

    unique_letters = set("".join(words))
    if len(unique_letters) > CELL_COUNT:
        return None, {
            "status": "unsatisfiable",
            "message": f"В словах {len(unique_letters)} разных букв, а клеток только 16.",
        }

    minimum_letter_cells = _necessary_cell_counts(words)
    minimum_cells = sum(minimum_letter_cells.values())
    if minimum_cells > CELL_COUNT:
        return None, {
            "status": "unsatisfiable",
            "message": (
                f"Из-за повторов букв нужно минимум {minimum_cells} клеток. "
                "Между разными словами клетки переиспользовать можно, внутри одного — нельзя."
            ),
        }

    essential = _essential_words(words)
    variable_count = sum(map(len, essential))
    if variable_count > MAX_ESSENTIAL_POSITIONS:
        return None, {
            "status": "invalid",
            "message": (
                "После удаления вложенных слов осталось слишком много позиций для браузерного поиска "
                f"({variable_count}, лимит {MAX_ESSENTIAL_POSITIONS})."
            ),
        }

    return {
        "words": words,
        "essential": essential,
        "minimum_letter_cells": minimum_letter_cells,
        "minimum_cells": minimum_cells,
        "unique_letters": len(unique_letters),
        "variable_count": variable_count,
    }, None


def _cell_count_plans(problem: dict) -> list[tuple[dict[str, int], dict[str, int] | None]]:
    """Split a one-spare-cell search into disjoint, tighter subproblems.

    With 15 mandatory cells, every visible board either leaves one cell empty
    or gives exactly one letter one extra cell.  Selecting that case up front
    exposes far more equality constraints without losing completeness.
    """

    minimum = problem["minimum_letter_cells"]
    spare_cells = CELL_COUNT - problem["minimum_cells"]
    if spare_cells != 1:
        return [(minimum, None)]

    plans: list[tuple[dict[str, int], dict[str, int] | None]] = [
        (minimum, minimum),  # one genuinely unused cell
    ]
    occurrences = Counter("".join(problem["essential"]))
    extra_letters = sorted(
        (
            letter
            for letter, count in occurrences.items()
            if count > minimum[letter]
        ),
        key=lambda letter: (-occurrences[letter], letter),
    )
    for letter in extra_letters:
        exact_counts = dict(minimum)
        exact_counts[letter] += 1
        plans.append((exact_counts, exact_counts))
    return plans


def _base_stats(
    problem: dict,
    solver: WordGridCsp,
    started: float,
    nodes_visited: int | None = None,
    search_plans: int = 1,
) -> dict:
    return {
        "elapsed_ms": round((time.perf_counter() - started) * 1000),
        "nodes": solver.nodes_visited if nodes_visited is None else nodes_visited,
        "search_plans": search_plans,
        "variables": problem["variable_count"],
        "essential_words": len(problem["essential"]),
        "removed_words": len(problem["words"]) - len(problem["essential"]),
        "minimum_cells": problem["minimum_cells"],
        "unique_letters": problem["unique_letters"],
    }


def _unique_solution_phrase(count: int) -> str:
    if count % 10 == 1 and count % 100 != 11:
        return f"{count} уникальное решение"
    if count % 10 in (2, 3, 4) and count % 100 not in (12, 13, 14):
        return f"{count} уникальных решения"
    return f"{count} уникальных решений"


def _median_from_counts(counts: Counter[float], total: int) -> float:
    """Return the exact median of a frequency table without storing samples."""

    if total <= 0:
        raise ValueError("Median requires at least one value")
    lower_index = (total - 1) // 2
    upper_index = total // 2
    seen = 0
    lower_value: float | None = None
    upper_value: float | None = None
    for value in sorted(counts):
        next_seen = seen + counts[value]
        if lower_value is None and seen <= lower_index < next_seen:
            lower_value = value
        if seen <= upper_index < next_seen:
            upper_value = value
            break
        seen = next_seen
    assert lower_value is not None and upper_value is not None
    return round((lower_value + upper_value) / 2, 6)


def _average_benchmarks(
    counts: Counter[float],
    bottom_heap: list[float],
    best_average: float | None,
    total: int,
) -> dict | None:
    if total == 0 or best_average is None:
        return None
    bottom_values = [-value for value in bottom_heap]
    return {
        "best": best_average,
        "median": _median_from_counts(counts, total),
        "bottom_100_average": round(sum(bottom_values) / len(bottom_values), 6),
        "bottom_count": len(bottom_values),
        "sample_count": total,
    }


def evaluate_board(raw_board: str, raw_words: str) -> dict:
    """Score a user-provided full board against the current word list."""

    try:
        board = _normalise_board(raw_board)
        words = _normalise_words(raw_words)
    except InputError as error:
        return {"status": "invalid", "message": str(error)}

    board_list = list(board)
    positions = _letter_positions(board_list)
    missing_words = [
        word
        for word in words
        if len(word) > CELL_COUNT or _find_easiest_word_path(board_list, word, positions) is None
    ]
    if missing_words:
        shown = ", ".join(f"«{word}»" for word in missing_words[:5])
        remainder = len(missing_words) - 5
        suffix = f" и ещё {remainder}" if remainder > 0 else ""
        return {
            "status": "not_solution",
            "message": f"В этой конфигурации не читаются слова: {shown}{suffix}.",
        }

    return {
        "status": "evaluated",
        "message": "Конфигурация подходит: все слова читаются по правилам.",
        **_solution_payload(board, words),
    }


def solve(raw_words: str, time_limit_seconds: float = DEFAULT_TIME_LIMIT_SECONDS) -> dict:
    """Find one board and return a JSON-friendly result dictionary."""

    started = time.perf_counter()
    problem, error = _prepare_problem(raw_words)
    if error is not None:
        return error
    assert problem is not None

    time_limit_seconds = max(0.1, min(float(time_limit_seconds), MAX_TIME_LIMIT_SECONDS))
    deadline = started + time_limit_seconds
    plans = _cell_count_plans(problem)
    total_nodes = 0
    plans_started = 0
    solution = None
    solver: WordGridCsp | None = None
    for minimum_counts, maximum_counts in plans:
        plans_started += 1
        solver = WordGridCsp(
            problem["essential"],
            minimum_counts,
            deadline=deadline,
            maximum_letter_cells=maximum_counts,
        )
        try:
            solution = solver.solve()
        except SearchTimedOut:
            total_nodes += solver.nodes_visited
            return {
                "status": "timeout",
                "message": (
                    f"За {time_limit_seconds:g} с не удалось ни найти квадрат, ни доказать, что его нет. "
                    "Можно увеличить лимит времени или запустить поиск для меньшего набора."
                ),
                "stats": _base_stats(
                    problem,
                    solver,
                    started,
                    nodes_visited=total_nodes,
                    search_plans=plans_started,
                ),
            }
        total_nodes += solver.nodes_visited
        if solution is not None:
            break

    assert solver is not None
    base_stats = _base_stats(
        problem,
        solver,
        started,
        nodes_visited=total_nodes,
        search_plans=plans_started,
    )

    if solution is None:
        return {
            "status": "unsatisfiable",
            "message": "Заполнения нет: точный поиск перебрал все допустимые варианты.",
            "stats": base_stats,
        }

    _, owners = solution
    payload = _solution_payload(_canonical_board(owners), problem["words"])

    return {
        "status": "solved",
        "message": "Квадрат найден. Выберите слово, чтобы увидеть порядок клеток.",
        "stats": base_stats,
        **payload,
    }


def enumerate_solutions(
    raw_words: str,
    time_limit_seconds: float = DEFAULT_TIME_LIMIT_SECONDS,
    max_solutions: int = DEFAULT_MAX_UNIQUE_SOLUTIONS,
    display_limit: int = DEFAULT_DISPLAY_LIMIT,
    on_update: Callable[[str], object] | None = None,
    top_limit: int = DEFAULT_TOP_LIMIT,
) -> dict:
    """Count boards, stream the first ones, and retain a bounded ranked top."""

    started = time.perf_counter()
    problem, error = _prepare_problem(raw_words)
    if error is not None:
        if error["status"] == "unsatisfiable":
            return {
                **error,
                "count": 0,
                "exact": True,
                "stored_count": 0,
                "top_count": 0,
                "top_solutions": [],
                "average_benchmarks": None,
            }
        return error
    assert problem is not None

    time_limit_seconds = max(0.1, min(float(time_limit_seconds), MAX_TIME_LIMIT_SECONDS))
    max_solutions = max(1, min(int(max_solutions), DEFAULT_MAX_UNIQUE_SOLUTIONS))
    display_limit = max(1, min(int(display_limit), DEFAULT_DISPLAY_LIMIT))
    top_limit = max(1, min(int(top_limit), DEFAULT_TOP_LIMIT))
    deadline = started + time_limit_seconds
    plans = _cell_count_plans(problem)
    last_count_update = started
    best_rank: tuple[float, float] | None = None
    best_solution: dict | None = None
    best_discovery_index = 0
    top_heap: list[tuple[float, float, int, tuple[str, ...]]] = []
    average_counts: Counter[float] = Counter()
    bottom_average_heap: list[float] = []
    best_average: float | None = None

    def emit(payload: dict) -> None:
        if on_update is not None:
            on_update(json.dumps(payload, ensure_ascii=False))

    def on_unique_board(board: tuple[str, ...], count: int) -> None:
        nonlocal best_average, best_discovery_index, best_rank, best_solution, last_count_update
        now = time.perf_counter()
        complexity = _board_complexity(
            board,
            problem["words"],
            all_letters_unique=problem["unique_letters"] == CELL_COUNT,
        )
        rank = (
            complexity["minimum"],
            complexity["average"],
        )
        average = complexity["average"]
        average_counts[average] += 1
        best_average = average if best_average is None else max(best_average, average)
        if len(bottom_average_heap) < DEFAULT_BOTTOM_LIMIT:
            heappush(bottom_average_heap, -average)
        elif average < -bottom_average_heap[0]:
            heapreplace(bottom_average_heap, -average)
        # Earlier discovery wins an otherwise exact tie.  The heap root is the
        # weakest retained board, so each solution costs only O(log top_limit).
        top_entry = (*rank, -count, board)
        if len(top_heap) < top_limit:
            heappush(top_heap, top_entry)
        elif top_entry[:3] > top_heap[0][:3]:
            heapreplace(top_heap, top_entry)
        is_best = best_rank is None or rank > best_rank
        solution = (
            _solution_payload(board, problem["words"], complexity)
            if count <= display_limit or is_best
            else None
        )
        if is_best:
            best_rank = rank
            best_solution = solution
            best_discovery_index = count

        if count <= display_limit:
            assert solution is not None
            emit({
                "event": "solution",
                "count": count,
                "solution": solution,
                "best_so_far": is_best,
            })
            last_count_update = now
        elif is_best:
            assert solution is not None
            emit({"event": "best", "count": count, "solution": solution})
            last_count_update = now
        elif count % 100 == 0 or now - last_count_update >= 0.15:
            emit({"event": "count", "count": count})
            last_count_update = now

    completed = True
    stop_reason: str | None = None
    count = 0
    total_nodes = 0
    plans_started = 0
    solver: WordGridCsp | None = None
    for minimum_counts, maximum_counts in plans:
        plans_started += 1
        solver = WordGridCsp(
            problem["essential"],
            minimum_counts,
            deadline=deadline,
            maximum_letter_cells=maximum_counts,
        )
        count_offset = count

        def on_plan_board(board: tuple[str, ...], local_count: int) -> None:
            on_unique_board(board, count_offset + local_count)

        try:
            branch_completed, branch_stop_reason = solver.enumerate_solutions(
                on_plan_board,
                max_solutions - count,
            )
        except SearchTimedOut:
            total_nodes += solver.nodes_visited
            count += len(solver.seen_boards)
            completed = False
            stop_reason = "timeout"
            break
        total_nodes += solver.nodes_visited
        count += len(solver.seen_boards)
        if not branch_completed:
            completed = False
            stop_reason = branch_stop_reason
            break

    assert solver is not None
    stats = _base_stats(
        problem,
        solver,
        started,
        nodes_visited=total_nodes,
        search_plans=plans_started,
    )
    stored_count = min(count, display_limit)
    ranked_entries = sorted(top_heap, key=lambda entry: entry[:3], reverse=True)
    top_solutions = [
        _solution_payload(
            entry[3],
            problem["words"],
            {"minimum": entry[0], "average": entry[1]},
        )
        for entry in ranked_entries
    ]
    if top_solutions:
        best_solution = top_solutions[0]
        best_discovery_index = -ranked_entries[0][2]
    top_count = len(top_solutions)
    average_benchmarks = _average_benchmarks(
        average_counts,
        bottom_average_heap,
        best_average,
        count,
    )

    if completed and count == 0:
        return {
            "status": "unsatisfiable",
            "message": "Заполнения нет: точный поиск перебрал все допустимые варианты.",
            "count": 0,
            "exact": True,
            "stored_count": 0,
            "top_count": 0,
            "top_solutions": [],
            "average_benchmarks": None,
            "stats": stats,
        }
    if completed:
        return {
            "status": "complete",
            "message": (
                f"Поиск завершён: найдено {_unique_solution_phrase(count)}. "
                f"Топ-{top_count} отсортирован по убыванию запутанности."
            ),
            "count": count,
            "exact": True,
            "stored_count": stored_count,
            "top_count": top_count,
            "top_solutions": top_solutions,
            "average_benchmarks": average_benchmarks,
            "best_solution": best_solution,
            "best_discovery_index": best_discovery_index,
            "stats": stats,
        }

    if stop_reason == "limit":
        message = (
            f"Найдено решений: не менее {count} — достигнут защитный предел. "
            f"Для просмотра сохранены первые {stored_count} и топ-{top_count} среди найденных."
        )
    else:
        message = (
            f"За {time_limit_seconds:g} с найдено решений: не менее {count}; полный обход не завершён. "
            f"Для просмотра сохранены первые {stored_count} и топ-{top_count} среди найденных."
        )
    return {
        "status": "partial" if count else "timeout",
        "message": message,
        "count": count,
        "exact": False,
        "stored_count": stored_count,
        "top_count": top_count,
        "top_solutions": top_solutions,
        "average_benchmarks": average_benchmarks,
        "best_solution": best_solution,
        "best_discovery_index": best_discovery_index,
        "stop_reason": stop_reason,
        "stats": stats,
    }


def maximise_words_and_enumerate(
    raw_words: str,
    time_limit_seconds: float = DEFAULT_TIME_LIMIT_SECONDS,
    max_solutions: int = DEFAULT_MAX_UNIQUE_SOLUTIONS,
    display_limit: int = DEFAULT_DISPLAY_LIMIT,
    on_update: Callable[[str], object] | None = None,
    top_limit: int = DEFAULT_TOP_LIMIT,
) -> dict:
    """Keep the normal enumeration, falling back to a maximum word subset.

    A subset search starts only after the complete input has been proved
    impossible.  Candidates are checked in decreasing cardinality, so the
    first satisfiable one is an exact maximum-cardinality subset.  If the
    shared deadline expires, no smaller candidate is presented as optimal.
    """

    started = time.perf_counter()
    time_limit_seconds = max(0.1, min(float(time_limit_seconds), MAX_TIME_LIMIT_SECONDS))
    deadline = started + time_limit_seconds
    full_result = enumerate_solutions(
        raw_words,
        time_limit_seconds,
        max_solutions,
        display_limit,
        on_update,
        top_limit,
    )
    if full_result.get("status") != "unsatisfiable":
        return full_result

    try:
        words = _normalise_words(raw_words)
    except InputError:
        return full_result

    tested = 0
    seen_essential_sets: set[tuple[str, ...]] = set()
    last_progress = 0.0

    def emit(payload: dict) -> None:
        if on_update is not None:
            on_update(json.dumps(payload, ensure_ascii=False))

    try:
        candidates = _iter_candidate_subsets(words, len(words) - 1, deadline)
        for selected_words in candidates:
            now = time.perf_counter()
            if now >= deadline:
                raise SearchTimedOut

            essential_key = tuple(_essential_words(selected_words))
            if essential_key in seen_essential_sets:
                continue
            seen_essential_sets.add(essential_key)
            tested += 1
            if tested == 1 or now - last_progress >= 0.15:
                emit({
                    "event": "selection-progress",
                    "target_count": len(selected_words),
                    "tested": tested,
                })
                last_progress = now

            remaining = deadline - time.perf_counter()
            candidate_result = solve("\n".join(selected_words), remaining)
            if candidate_result["status"] == "timeout":
                raise SearchTimedOut
            if candidate_result["status"] == "invalid":
                raise SubsetSearchIncomplete(candidate_result["message"])
            if candidate_result["status"] != "solved":
                continue

            selection = _selection_metadata(words, selected_words, tested)
            emit({"event": "selection", "selection": selection})
            subset_search_elapsed_ms = round((time.perf_counter() - started) * 1000)
            remaining = deadline - time.perf_counter()
            selected_raw_words = "\n".join(selected_words)
            if remaining > 0.1:
                result = enumerate_solutions(
                    selected_raw_words,
                    remaining,
                    max_solutions,
                    display_limit,
                    on_update,
                    top_limit,
                )
            else:
                result = {"status": "timeout", "count": 0}

            # The feasibility check already produced a board.  Preserve it if
            # the shared time limit ended before enumeration rediscovered it.
            if not result.get("count"):
                solution = {
                    "board": candidate_result["board"],
                    "words": candidate_result["words"],
                    "complexity": candidate_result["complexity"],
                }
                emit({
                    "event": "solution",
                    "count": 1,
                    "solution": solution,
                    "best_so_far": True,
                })
                average = solution["complexity"]["average"]
                result = {
                    "status": "partial",
                    "message": (
                        f"Максимальное подмножество найдено, но лимита времени хватило "
                        "только на одно поле для него."
                    ),
                    "count": 1,
                    "exact": False,
                    "stored_count": 1,
                    "top_count": 1,
                    "top_solutions": [solution],
                    "average_benchmarks": {
                        "best": average,
                        "median": average,
                        "bottom_100_average": average,
                        "bottom_count": 1,
                        "sample_count": 1,
                    },
                    "best_solution": solution,
                    "best_discovery_index": 1,
                    "stop_reason": "timeout",
                    "stats": candidate_result.get("stats", {}),
                }

            result["word_selection"] = selection
            result.setdefault("stats", {})["subset_candidates_tested"] = tested
            result["stats"]["subset_search_elapsed_ms"] = subset_search_elapsed_ms
            return result
    except SearchTimedOut:
        return {
            "status": "timeout",
            "message": (
                f"Полный набор не складывается. За {time_limit_seconds:g} с не удалось "
                "доказать, какое подмножество содержит максимум слов. Увеличьте лимит времени."
            ),
            "count": 0,
            "exact": False,
            "stored_count": 0,
            "top_count": 0,
            "top_solutions": [],
            "average_benchmarks": None,
            "subset_search": {"candidates_tested": tested},
        }
    except SubsetSearchIncomplete as error:
        return {
            "status": "invalid",
            "message": (
                "Не удалось доказать максимальность подмножества из-за защитного "
                f"ограничения браузерного решателя. {error}"
            ),
            "count": 0,
            "exact": False,
            "stored_count": 0,
            "top_count": 0,
            "top_solutions": [],
            "average_benchmarks": None,
            "subset_search": {"candidates_tested": tested},
        }

    return {
        "status": "unsatisfiable",
        "message": "Ни одно введённое слово нельзя разместить на поле по правилам.",
        "count": 0,
        "exact": True,
        "stored_count": 0,
        "top_count": 0,
        "top_solutions": [],
        "average_benchmarks": None,
        "word_selection": _selection_metadata(words, [], tested),
    }


def solve_json(raw_words: str, time_limit_seconds: float = DEFAULT_TIME_LIMIT_SECONDS) -> str:
    """Stable string boundary used by the JavaScript worker."""

    return json.dumps(solve(raw_words, time_limit_seconds), ensure_ascii=False)


def evaluate_json(raw_board: str, raw_words: str) -> str:
    """JSON boundary for scoring a manually entered board in the Worker."""

    return json.dumps(evaluate_board(raw_board, raw_words), ensure_ascii=False)


def enumerate_json(
    raw_words: str,
    time_limit_seconds: float = DEFAULT_TIME_LIMIT_SECONDS,
    max_solutions: int = DEFAULT_MAX_UNIQUE_SOLUTIONS,
    display_limit: int = DEFAULT_DISPLAY_LIMIT,
    on_update: Callable[[str], object] | None = None,
    top_limit: int = DEFAULT_TOP_LIMIT,
) -> str:
    """Streaming JSON boundary used by the JavaScript worker."""

    result = enumerate_solutions(
        raw_words,
        time_limit_seconds,
        max_solutions,
        display_limit,
        on_update,
        top_limit,
    )
    return json.dumps(result, ensure_ascii=False)

def maximise_and_enumerate_json(
    raw_words: str,
    time_limit_seconds: float = DEFAULT_TIME_LIMIT_SECONDS,
    max_solutions: int = DEFAULT_MAX_UNIQUE_SOLUTIONS,
    display_limit: int = DEFAULT_DISPLAY_LIMIT,
    on_update: Callable[[str], object] | None = None,
    top_limit: int = DEFAULT_TOP_LIMIT,
) -> str:
    """Streaming JSON boundary with automatic maximum-subset fallback."""

    result = maximise_words_and_enumerate(
        raw_words,
        time_limit_seconds,
        max_solutions,
        display_limit,
        on_update,
        top_limit,
    )
    return json.dumps(result, ensure_ascii=False)
