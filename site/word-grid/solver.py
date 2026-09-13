"""Exact solver for a 4 x 4 Boggle-like word board.

The browser imports this file unchanged through Pyodide.  The search is modelled
as a constraint-satisfaction problem (CSP): every character position in every
essential word is a variable, and its domain is the set of 16 board cells.

There are three constraints:

* consecutive positions of a word must be neighbours on the board;
* all positions inside one word must use different cells;
* positions containing different letters cannot use the same cell.

The solver uses bit masks for the 16-cell domains, maintains arc consistency
for neighbour constraints, checks all-different constraints with bipartite
matching, and branches on the smallest remaining domain.  It is a complete
search: ``unsatisfiable`` means that every possible assignment was rejected.
"""

from __future__ import annotations

from collections.abc import Callable
from collections import Counter, defaultdict, deque
from heapq import heappop, heappush
import json
import re
import time
import unicodedata


GRID_SIDE = 4
CELL_COUNT = GRID_SIDE * GRID_SIDE
ALL_CELLS = (1 << CELL_COUNT) - 1
ROOT_CELL_ORBITS = (0, 1, 5)  # corner, non-corner edge, inner cell
MAX_WORDS = 80
MAX_ESSENTIAL_POSITIONS = 320
DEFAULT_TIME_LIMIT_SECONDS = 20.0
DEFAULT_DISPLAY_LIMIT = 200
DEFAULT_MAX_UNIQUE_SOLUTIONS = 100_000


def _build_neighbour_masks() -> tuple[int, ...]:
    masks: list[int] = []
    for cell in range(CELL_COUNT):
        row, column = divmod(cell, GRID_SIDE)
        mask = 0
        for row_delta in (-1, 0, 1):
            for column_delta in (-1, 0, 1):
                if row_delta == column_delta == 0:
                    continue
                neighbour_row = row + row_delta
                neighbour_column = column + column_delta
                if 0 <= neighbour_row < GRID_SIDE and 0 <= neighbour_column < GRID_SIDE:
                    mask |= 1 << (neighbour_row * GRID_SIDE + neighbour_column)
        masks.append(mask)
    return tuple(masks)


NEIGHBOUR_MASKS = _build_neighbour_masks()
WORD_SPLITTER = re.compile(r"[\n,;]+")


def _build_symmetry_maps() -> tuple[tuple[int, ...], ...]:
    """Map old cell indices to all eight rotations/reflections of the square."""

    maps: list[tuple[int, ...]] = []
    for reflected in (False, True):
        for rotations in range(4):
            mapping: list[int] = []
            for cell in range(CELL_COUNT):
                row, column = divmod(cell, GRID_SIDE)
                if reflected:
                    column = GRID_SIDE - 1 - column
                for _ in range(rotations):
                    row, column = column, GRID_SIDE - 1 - row
                mapping.append(row * GRID_SIDE + column)
            candidate = tuple(mapping)
            if candidate not in maps:
                maps.append(candidate)
    return tuple(maps)


SYMMETRY_MAPS = _build_symmetry_maps()


def _board_order_key(board: tuple[str, ...] | list[str]) -> tuple[str, ...]:
    return tuple(letter or "\U0010ffff" for letter in board)


def _canonical_board(owners: list[str | None]) -> tuple[str, ...]:
    """Return one stable representative of a board's symmetry class."""

    variants: list[tuple[str, ...]] = []
    for mapping in SYMMETRY_MAPS:
        transformed = [""] * CELL_COUNT
        for old_cell, new_cell in enumerate(mapping):
            transformed[new_cell] = owners[old_cell] or ""
        variants.append(tuple(transformed))
    # Empty cells sort last so sparse side-effect cases stay visually anchored
    # near the upper-left corner instead of drifting to the lower-right.
    return min(variants, key=_board_order_key)


class SearchTimedOut(Exception):
    """Raised when a bounded browser search reaches its deadline."""


class SolutionLimitReached(Exception):
    """Raised after the configured number of unique boards was collected."""


class InputError(ValueError):
    """Raised when the submitted word list cannot be interpreted."""


def _normalise_words(raw_words: str) -> list[str]:
    words: list[str] = []
    seen: set[str] = set()
    for raw_word in WORD_SPLITTER.split(raw_words):
        word = unicodedata.normalize("NFC", raw_word.strip().lower())
        if not word:
            continue
        if not word.isalpha():
            raise InputError(f"«{word}»: используйте только буквы, без пробелов и дефисов.")
        if word not in seen:
            seen.add(word)
            words.append(word)

    if not words:
        raise InputError("Введите хотя бы одно слово.")
    if len(words) > MAX_WORDS:
        raise InputError(f"Сейчас поддерживается не больше {MAX_WORDS} разных слов за один поиск.")
    return words


def _necessary_cell_counts(words: list[str]) -> dict[str, int]:
    """Minimum number of cells required for each letter.

    A board cell may be reused between words, so for a letter we need the
    maximum multiplicity in any one word, rather than the sum over all words.
    """

    required: dict[str, int] = defaultdict(int)
    for word in words:
        for letter, count in Counter(word).items():
            required[letter] = max(required[letter], count)
    return dict(required)


def _essential_words(words: list[str]) -> list[str]:
    """Drop constraints already guaranteed by a longer word.

    If ``кот`` is a substring of ``скотина``, every path for the latter already
    contains a valid path for the former.  Reverse paths are valid too.
    """

    essential: list[str] = []
    for word in sorted(words, key=lambda item: (-len(item), item)):
        if any(word in longer or word in longer[::-1] for longer in essential):
            continue
        essential.append(word)
    return essential


def _iter_cells(mask: int):
    while mask:
        bit = mask & -mask
        yield bit.bit_length() - 1
        mask ^= bit


def _has_distinct_matching(variable_ids: list[int], domains: list[int]) -> bool:
    """Check Hall's condition by finding a variable-to-cell matching."""

    ordered = sorted(variable_ids, key=lambda variable: domains[variable].bit_count())
    cell_to_variable = [-1] * CELL_COUNT

    def augment(variable: int, visited_cells: set[int]) -> bool:
        for cell in _iter_cells(domains[variable]):
            if cell in visited_cells:
                continue
            visited_cells.add(cell)
            previous = cell_to_variable[cell]
            if previous == -1 or augment(previous, visited_cells):
                cell_to_variable[cell] = variable
                return True
        return False

    return all(augment(variable, set()) for variable in ordered)


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
    """Recover the least tangled valid path for one word.

    A puzzle solver will notice the easiest occurrence, so ranking an arbitrary
    harder occurrence would overstate the board's difficulty.  The state keeps
    the used-cell mask, previous direction, and used movement families; this is
    an exact dynamic-programming search over simple paths.
    """

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

    # Dijkstra works because all score components can be charged when a step is
    # added: a turn costs two units, a diagonal one, and every movement family
    # after the first costs two.  The first complete path is therefore optimal.
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
            family_bit = 1 << _direction_family(direction)
            turn_cost = 2 * int(previous_direction >= 0 and previous_direction != direction_code)
            diagonal_cost = int(_direction_family(direction) == 2)
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
        if path is None:  # Defensive assertion: a solved CSP must expose every path.
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


class WordGridCsp:
    """Specialised CSP with 16-bit domains and exact backtracking."""

    def __init__(self, words: list[str], minimum_letter_cells: dict[str, int], deadline: float):
        self.words = words
        self.minimum_letter_cells = minimum_letter_cells
        minimum_total = sum(minimum_letter_cells.values())
        self.maximum_letter_cells = {
            letter: CELL_COUNT - (minimum_total - minimum)
            for letter, minimum in minimum_letter_cells.items()
        }
        self.deadline = deadline

        self.letters: list[str] = []
        self.word_variables: list[list[int]] = []
        self.variable_word: list[int] = []
        self.adjacent_variables: list[list[int]] = []
        self.letter_variables: dict[str, list[int]] = defaultdict(list)

        for word_index, word in enumerate(words):
            variables: list[int] = []
            for letter in word:
                variable = len(self.letters)
                variables.append(variable)
                self.letters.append(letter)
                self.variable_word.append(word_index)
                self.adjacent_variables.append([])
                self.letter_variables[letter].append(variable)
            self.word_variables.append(variables)
            for first, second in zip(variables, variables[1:]):
                self.adjacent_variables[first].append(second)
                self.adjacent_variables[second].append(first)

        self.nodes_visited = 0
        self.failed_states: set[tuple[int, ...]] = set()
        self.seen_boards: set[tuple[str, ...]] = set()
        self.neighbour_union_cache: dict[int, int] = {0: 0}

    def _check_deadline(self) -> None:
        if time.perf_counter() >= self.deadline:
            raise SearchTimedOut

    def _neighbour_union(self, mask: int) -> int:
        cached = self.neighbour_union_cache.get(mask)
        if cached is not None:
            return cached
        result = 0
        for cell in _iter_cells(mask):
            result |= NEIGHBOUR_MASKS[cell]
        self.neighbour_union_cache[mask] = result
        return result

    def _capacity_possible(self, domains: list[int], owners: list[str | None]) -> bool:
        """Can different letters still reserve their minimum cell counts?"""

        owned_by_letter: dict[str, int] = defaultdict(int)
        all_owned = 0
        for cell, letter in enumerate(owners):
            if letter is not None:
                bit = 1 << cell
                owned_by_letter[letter] |= bit
                all_owned |= bit

        demands: list[tuple[str, int]] = []
        for letter, minimum in self.minimum_letter_cells.items():
            extra = minimum - owned_by_letter[letter].bit_count()
            if extra > 0:
                candidates = 0
                for variable in self.letter_variables[letter]:
                    candidates |= domains[variable]
                candidates &= ~all_owned
                demands.extend((letter, candidates) for _ in range(extra))

        demands.sort(key=lambda item: item[1].bit_count())
        cell_to_demand = [-1] * CELL_COUNT

        def augment(demand_index: int, visited_cells: set[int]) -> bool:
            for cell in _iter_cells(demands[demand_index][1]):
                if cell in visited_cells:
                    continue
                visited_cells.add(cell)
                previous = cell_to_demand[cell]
                if previous == -1 or augment(previous, visited_cells):
                    cell_to_demand[cell] = demand_index
                    return True
            return False

        return all(augment(index, set()) for index in range(len(demands)))

    def _word_path_possible(self, variable_ids: list[int], domains: list[int]) -> bool:
        """Check one whole word, including adjacency and all-different at once."""

        if len(variable_ids) == 1:
            return bool(domains[variable_ids[0]])
        if domains[variable_ids[-1]].bit_count() < domains[variable_ids[0]].bit_count():
            variable_ids = variable_ids[::-1]

        dead_states: set[tuple[int, int, int]] = set()
        visited_states = 0

        def extend(position: int, cell: int, used_cells: int) -> bool:
            nonlocal visited_states
            if position == len(variable_ids) - 1:
                return True
            state = (position, cell, used_cells)
            if state in dead_states:
                return False

            visited_states += 1
            if visited_states % 2048 == 0:
                self._check_deadline()

            next_domain = domains[variable_ids[position + 1]]
            candidates = NEIGHBOUR_MASKS[cell] & next_domain & ~used_cells
            ordered = sorted(
                _iter_cells(candidates),
                key=lambda candidate: (
                    NEIGHBOUR_MASKS[candidate]
                    & (domains[variable_ids[position + 2]] if position + 2 < len(variable_ids) else ALL_CELLS)
                    & ~(used_cells | (1 << candidate))
                ).bit_count(),
            )
            for candidate in ordered:
                if extend(position + 1, candidate, used_cells | (1 << candidate)):
                    return True
            dead_states.add(state)
            return False

        start_domain = domains[variable_ids[0]]
        return any(extend(0, start, 1 << start) for start in _iter_cells(start_domain))

    def _propagate(
        self,
        domains: list[int],
        owners: list[str | None],
        changed_variables: list[int],
    ) -> bool:
        """Propagate singleton, adjacency, and matching constraints."""

        queue = deque(changed_variables)
        queued = set(changed_variables)
        propagated_singletons: set[int] = set()

        def narrow(variable: int, new_domain: int) -> bool:
            if new_domain == domains[variable]:
                return True
            domains[variable] = new_domain
            if not new_domain:
                return False
            if variable not in queued:
                queued.add(variable)
                queue.append(variable)
            return True

        while queue:
            variable = queue.popleft()
            queued.discard(variable)
            domain = domains[variable]
            if not domain:
                return False

            # Arc consistency for the two path neighbours of this position.
            supported_cells = self._neighbour_union(domain)
            for neighbour in self.adjacent_variables[variable]:
                if not narrow(neighbour, domains[neighbour] & supported_cells):
                    return False

            if domain & (domain - 1) or variable in propagated_singletons:
                continue
            propagated_singletons.add(variable)
            cell = domain.bit_length() - 1
            letter = self.letters[variable]

            existing_owner = owners[cell]
            if existing_owner is not None and existing_owner != letter:
                return False
            if existing_owner is None:
                owners[cell] = letter
                for other_letter, variables in self.letter_variables.items():
                    if other_letter == letter:
                        continue
                    for other in variables:
                        if not narrow(other, domains[other] & ~domain):
                            return False

                # Other letters must keep their minimum number of distinct
                # cells.  Once this letter reaches its resulting upper bound,
                # all its remaining occurrences have to reuse those cells.
                owned_by_letter = 0
                for owned_cell, owner in enumerate(owners):
                    if owner == letter:
                        owned_by_letter |= 1 << owned_cell
                if owned_by_letter.bit_count() > self.maximum_letter_cells[letter]:
                    return False
                if owned_by_letter.bit_count() == self.maximum_letter_cells[letter]:
                    for same_letter_variable in self.letter_variables[letter]:
                        if not narrow(
                            same_letter_variable,
                            domains[same_letter_variable] & owned_by_letter,
                        ):
                            return False

            # All positions of one word must be pairwise different, including
            # repeated occurrences of the same letter.
            for other in self.word_variables[self.variable_word[variable]]:
                if other != variable and not narrow(other, domains[other] & ~domain):
                    return False

            if len(propagated_singletons) % 32 == 0:
                self._check_deadline()

        # Arc consistency works on pairs and can miss a conflict that is only
        # visible across the whole word.  Check that each word still has at
        # least one complete simple path through its current domains.
        for variables in self.word_variables:
            if not self._word_path_possible(variables, domains):
                return False
        return self._capacity_possible(domains, owners)

    def _choose_variable(self, domains: list[int]) -> int | None:
        candidates = [variable for variable, domain in enumerate(domains) if domain & (domain - 1)]
        if not candidates:
            return None

        def priority(variable: int) -> tuple[int, int, int]:
            domain_size = domains[variable].bit_count()
            adjacency_pressure = sum(
                CELL_COUNT + 1 - domains[neighbour].bit_count()
                for neighbour in self.adjacent_variables[variable]
            )
            word_length = len(self.word_variables[self.variable_word[variable]])
            return domain_size, -adjacency_pressure, -word_length

        return min(candidates, key=priority)

    def _ordered_cells(self, variable: int, domains: list[int], root: bool) -> list[int]:
        cells = list(_iter_cells(domains[variable]))
        if root and domains[variable] == ALL_CELLS:
            # The empty square has eight rotations/reflections.  Any solution
            # can move this first occurrence to one of these three cell orbits.
            cells = [cell for cell in ROOT_CELL_ORBITS if domains[variable] & (1 << cell)]

        word_variables = self.word_variables[self.variable_word[variable]]
        letter = self.letters[variable]

        def score(cell: int) -> int:
            bit = 1 << cell
            adjacency_options = sum(
                (NEIGHBOUR_MASKS[cell] & domains[neighbour]).bit_count()
                for neighbour in self.adjacent_variables[variable]
            )
            same_letter_sharing = sum(
                1 for other in self.letter_variables[letter]
                if other != variable and domains[other] & bit
            )
            immediate_removals = sum(
                1 for other in word_variables
                if other != variable and domains[other] & bit
            )
            return 12 * adjacency_options + same_letter_sharing - immediate_removals

        return sorted(cells, key=lambda cell: (-score(cell), cell))

    def _search(
        self,
        domains: list[int],
        owners: list[str | None],
        depth: int,
    ) -> tuple[list[int], list[str | None]] | None:
        self.nodes_visited += 1
        self._check_deadline()

        state_key = tuple(domains)
        if state_key in self.failed_states:
            return None

        variable = self._choose_variable(domains)
        if variable is None:
            return domains, owners

        for cell in self._ordered_cells(variable, domains, root=depth == 0):
            next_domains = domains.copy()
            next_owners = owners.copy()
            next_domains[variable] = 1 << cell
            if self._propagate(next_domains, next_owners, [variable]):
                solution = self._search(next_domains, next_owners, depth + 1)
                if solution is not None:
                    return solution

        if len(self.failed_states) < 100_000:
            self.failed_states.add(state_key)
        return None

    def _enumerate_search(
        self,
        domains: list[int],
        owners: list[str | None],
        depth: int,
        on_unique_board: Callable[[tuple[str, ...], int], None],
        max_solutions: int,
    ) -> bool:
        """Visit every leaf, returning whether this subtree had any CSP solution."""

        self.nodes_visited += 1
        self._check_deadline()

        state_key = tuple(domains)
        if state_key in self.failed_states:
            return False

        variable = self._choose_variable(domains)
        if variable is None:
            board = _canonical_board(owners)
            if board not in self.seen_boards:
                self.seen_boards.add(board)
                on_unique_board(board, len(self.seen_boards))
                if len(self.seen_boards) >= max_solutions:
                    raise SolutionLimitReached
            return True

        found_assignment = False
        for cell in self._ordered_cells(variable, domains, root=depth == 0):
            next_domains = domains.copy()
            next_owners = owners.copy()
            next_domains[variable] = 1 << cell
            if self._propagate(next_domains, next_owners, [variable]):
                found_assignment = self._enumerate_search(
                    next_domains,
                    next_owners,
                    depth + 1,
                    on_unique_board,
                    max_solutions,
                ) or found_assignment

        if not found_assignment and len(self.failed_states) < 100_000:
            self.failed_states.add(state_key)
        return found_assignment

    def _initial_state(self) -> tuple[list[int], list[str | None]] | None:
        domains = [ALL_CELLS] * len(self.letters)
        owners: list[str | None] = [None] * CELL_COUNT
        if not all(_has_distinct_matching(variables, domains) for variables in self.word_variables):
            return None
        if not self._capacity_possible(domains, owners):
            return None
        return domains, owners

    def solve(self) -> tuple[list[int], list[str | None]] | None:
        initial_state = self._initial_state()
        if initial_state is None:
            return None
        domains, owners = initial_state
        return self._search(domains, owners, 0)

    def enumerate_solutions(
        self,
        on_unique_board: Callable[[tuple[str, ...], int], None],
        max_solutions: int,
    ) -> tuple[bool, str | None]:
        """Enumerate unique boards; return completion and an optional stop reason."""

        self.seen_boards.clear()
        initial_state = self._initial_state()
        if initial_state is None:
            return True, None
        domains, owners = initial_state
        try:
            self._enumerate_search(domains, owners, 0, on_unique_board, max_solutions)
        except SolutionLimitReached:
            return False, "limit"
        return True, None


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


def _base_stats(problem: dict, solver: WordGridCsp, started: float) -> dict:
    return {
        "elapsed_ms": round((time.perf_counter() - started) * 1000),
        "nodes": solver.nodes_visited,
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


def solve(raw_words: str, time_limit_seconds: float = DEFAULT_TIME_LIMIT_SECONDS) -> dict:
    """Find one board and return a JSON-friendly result dictionary."""

    started = time.perf_counter()
    problem, error = _prepare_problem(raw_words)
    if error is not None:
        return error
    assert problem is not None

    time_limit_seconds = max(0.1, float(time_limit_seconds))
    solver = WordGridCsp(
        problem["essential"],
        problem["minimum_letter_cells"],
        deadline=started + time_limit_seconds,
    )

    try:
        solution = solver.solve()
    except SearchTimedOut:
        return {
            "status": "timeout",
            "message": (
                f"За {time_limit_seconds:g} с не удалось ни найти квадрат, ни доказать, что его нет. "
                "Поиск можно остановить без зависания страницы и запустить для меньшего набора."
            ),
            "stats": _base_stats(problem, solver, started),
        }

    base_stats = _base_stats(problem, solver, started)

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
) -> dict:
    """Count unique boards and stream the first displayable solutions as JSON."""

    started = time.perf_counter()
    problem, error = _prepare_problem(raw_words)
    if error is not None:
        if error["status"] == "unsatisfiable":
            return {**error, "count": 0, "exact": True, "stored_count": 0}
        return error
    assert problem is not None

    time_limit_seconds = max(0.1, float(time_limit_seconds))
    max_solutions = max(1, min(int(max_solutions), DEFAULT_MAX_UNIQUE_SOLUTIONS))
    display_limit = max(1, min(int(display_limit), DEFAULT_DISPLAY_LIMIT))
    solver = WordGridCsp(
        problem["essential"],
        problem["minimum_letter_cells"],
        deadline=started + time_limit_seconds,
    )
    last_count_update = started
    best_rank: tuple[float, float] | None = None
    best_solution: dict | None = None
    best_discovery_index = 0

    def emit(payload: dict) -> None:
        if on_update is not None:
            on_update(json.dumps(payload, ensure_ascii=False))

    def on_unique_board(board: tuple[str, ...], count: int) -> None:
        nonlocal best_discovery_index, best_rank, best_solution, last_count_update
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

    completed = False
    stop_reason: str | None = None
    try:
        completed, stop_reason = solver.enumerate_solutions(on_unique_board, max_solutions)
    except SearchTimedOut:
        stop_reason = "timeout"

    count = len(solver.seen_boards)
    stats = _base_stats(problem, solver, started)
    stored_count = min(count, display_limit)

    if completed and count == 0:
        return {
            "status": "unsatisfiable",
            "message": "Заполнения нет: точный поиск перебрал все допустимые варианты.",
            "count": 0,
            "exact": True,
            "stored_count": 0,
            "stats": stats,
        }
    if completed:
        return {
            "status": "complete",
            "message": f"Поиск завершён: найдено {_unique_solution_phrase(count)}.",
            "count": count,
            "exact": True,
            "stored_count": stored_count,
            "best_solution": best_solution,
            "best_discovery_index": best_discovery_index,
            "stats": stats,
        }

    if stop_reason == "limit":
        message = (
            f"Найдено решений: не менее {count} — достигнут защитный предел. "
            f"Для просмотра сохранены первые {stored_count}; лучший кандидат доступен отдельно."
        )
    else:
        message = (
            f"За {time_limit_seconds:g} с найдено решений: не менее {count}; полный обход не завершён. "
            f"Для просмотра сохранены первые {stored_count}; лучший кандидат доступен отдельно."
        )
    return {
        "status": "partial" if count else "timeout",
        "message": message,
        "count": count,
        "exact": False,
        "stored_count": stored_count,
        "best_solution": best_solution,
        "best_discovery_index": best_discovery_index,
        "stop_reason": stop_reason,
        "stats": stats,
    }


def solve_json(raw_words: str, time_limit_seconds: float = DEFAULT_TIME_LIMIT_SECONDS) -> str:
    """Stable string boundary used by the JavaScript worker."""

    return json.dumps(solve(raw_words, time_limit_seconds), ensure_ascii=False)


def enumerate_json(
    raw_words: str,
    time_limit_seconds: float = DEFAULT_TIME_LIMIT_SECONDS,
    max_solutions: int = DEFAULT_MAX_UNIQUE_SOLUTIONS,
    display_limit: int = DEFAULT_DISPLAY_LIMIT,
    on_update: Callable[[str], object] | None = None,
) -> str:
    """Streaming JSON boundary used by the JavaScript worker."""

    result = enumerate_solutions(
        raw_words,
        time_limit_seconds,
        max_solutions,
        display_limit,
        on_update,
    )
    return json.dumps(result, ensure_ascii=False)
