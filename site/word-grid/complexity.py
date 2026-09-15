"""Path recovery and tangle scoring for solved word-grid boards."""

from __future__ import annotations

from collections import defaultdict
from heapq import heappop, heappush

from grid_model import GRID_SIDE, NEIGHBOUR_MASKS, _iter_cells


def _step_direction(first: int, second: int) -> tuple[int, int]:
    first_row, first_column = divmod(first, GRID_SIDE)
    second_row, second_column = divmod(second, GRID_SIDE)
    return second_row - first_row, second_column - first_column


def _direction_code(direction: tuple[int, int]) -> int:
    row_delta, column_delta = direction
    return (row_delta + 1) * 3 + column_delta + 1


def _direction_family(direction: tuple[int, int]) -> int:
    row_delta, column_delta = direction
    if row_delta == 0:
        return 0  # horizontal
    if column_delta == 0:
        return 1  # vertical
    return 2  # diagonal


def _path_complexity_values(path: list[int]) -> tuple[float, int, int, int, int]:
    turns = 0
    direction_families = 0
    diagonal_steps = 0
    previous_direction: tuple[int, int] | None = None
    for first, second in zip(path, path[1:]):
        direction = _step_direction(first, second)
        family = _direction_family(direction)
        direction_families |= 1 << family
        diagonal_steps += int(family == 2)
        turns += int(previous_direction is not None and previous_direction != direction)
        previous_direction = direction
    direction_types = direction_families.bit_count()
    mix_bonus = max(0, direction_types - 1)
    steps = len(path) - 1
    # A diagonal is less scannable than an axis-aligned step, but should weigh
    # less than a real turn.  Doubling keeps the internal score integral.
    score_units = 2 * turns + 2 * mix_bonus + diagonal_steps
    score = score_units / (2 * steps) if steps else 0.0
    return round(score, 6), turns, direction_types, mix_bonus, diagonal_steps


def _path_complexity(path: list[int]) -> dict:
    """Score a path by turns, direction mix, and diagonal steps."""

    score, turns, direction_types, mix_bonus, diagonal_steps = _path_complexity_values(path)
    return {
        "score": score,
        "turns": turns,
        "direction_types": direction_types,
        "mix_bonus": mix_bonus,
        "diagonal_steps": diagonal_steps,
    }


def _letter_positions(board: list[str]) -> dict[str, tuple[int, ...]]:
    positions: dict[str, list[int]] = defaultdict(list)
    for cell, letter in enumerate(board):
        if letter:
            positions[letter].append(cell)
    return {letter: tuple(cells) for letter, cells in positions.items()}


def _find_easiest_word_path(
    board: list[str],
    word: str,
    positions: dict[str, tuple[int, ...]] | None = None,
) -> list[int] | None:
    """Recover the least tangled valid path for one word."""

    if positions is None:
        positions = _letter_positions(board)
    if any(letter not in positions for letter in word):
        return None

    # The intended 16-unique-letter case has exactly one cell per letter.  Its
    # path and complexity can be recovered without any secondary search.
    if all(len(positions[letter]) == 1 for letter in set(word)):
        path = [positions[letter][0] for letter in word]
        if len(path) == len(set(path)) and all(
            NEIGHBOUR_MASKS[first] & (1 << second)
            for first, second in zip(path, path[1:])
        ):
            return path
        return None

    # Dijkstra works because every score component is charged when a step is
    # added: a turn costs two units, a diagonal one, and each extra movement
    # family two.  The first complete path is therefore optimal.
    queue: list[tuple[int, tuple[int, ...], int, int, int, int, int]] = []
    best_cost: dict[tuple[int, int, int, int, int], int] = {}
    for start in positions[word[0]]:
        state = (0, start, 1 << start, -1, 0)
        best_cost[state] = 0
        heappush(queue, (0, (start,), *state))

    while queue:
        cost, path, position, cell, used_cells, previous_direction, direction_families = heappop(queue)
        state = (position, cell, used_cells, previous_direction, direction_families)
        if best_cost.get(state) != cost:
            continue
        if position == len(word) - 1:
            return list(path)

        candidates = NEIGHBOUR_MASKS[cell] & ~used_cells
        for neighbour in _iter_cells(candidates):
            if board[neighbour] != word[position + 1]:
                continue
            direction = _step_direction(cell, neighbour)
            direction_code = _direction_code(direction)
            family = _direction_family(direction)
            family_bit = 1 << family
            turn_cost = 2 * int(previous_direction >= 0 and previous_direction != direction_code)
            diagonal_cost = int(family == 2)
            family_cost = 2 * int(bool(direction_families) and not direction_families & family_bit)
            next_cost = cost + turn_cost + diagonal_cost + family_cost
            next_state = (
                position + 1,
                neighbour,
                used_cells | (1 << neighbour),
                direction_code,
                direction_families | family_bit,
            )
            if next_cost >= best_cost.get(next_state, 1 << 30):
                continue
            best_cost[next_state] = next_cost
            heappush(queue, (next_cost, (*path, neighbour), *next_state))
    return None


def _board_complexity(
    board: tuple[str, ...],
    words: list[str],
    all_letters_unique: bool = False,
) -> dict:
    board_list = list(board)
    scores = []
    if all_letters_unique:
        cell_by_letter = {letter: cell for cell, letter in enumerate(board_list)}
        for word in words:
            path = [cell_by_letter[letter] for letter in word]
            scores.append(_path_complexity_values(path)[0])
    else:
        positions = _letter_positions(board_list)
        for word in words:
            path = _find_easiest_word_path(board_list, word, positions)
            if path is None:
                raise AssertionError(f"Could not recover the path for {word!r}")
            scores.append(_path_complexity_values(path)[0])
    return {
        "minimum": min(scores),
        "average": round(sum(scores) / len(scores), 6),
    }


def _solution_payload(
    board: tuple[str, ...],
    words: list[str],
    complexity: dict | None = None,
) -> dict:
    word_results = []
    board_list = list(board)
    positions = _letter_positions(board_list)
    for word in words:
        path = _find_easiest_word_path(board_list, word, positions)
        if path is None:
            raise AssertionError(f"Could not recover the path for {word!r}")
        word_results.append({
            "word": word,
            "path": path,
            "complexity": _path_complexity(path),
        })

    if complexity is None:
        scores = [result["complexity"]["score"] for result in word_results]
        complexity = {
            "minimum": min(scores),
            "average": round(sum(scores) / len(scores), 6),
        }
    return {"board": board_list, "words": word_results, "complexity": complexity}
