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
from heapq import heappop, heappush, heapreplace
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
MAX_TIME_LIMIT_SECONDS = 600.0
DEFAULT_DISPLAY_LIMIT = 200
DEFAULT_TOP_LIMIT = 100
DEFAULT_BOTTOM_LIMIT = 100
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


class SubsetSearchIncomplete(Exception):
    """Raised when a candidate exceeds a browser safety limit."""


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


def _normalise_board(raw_board: str) -> tuple[str, ...]:
    """Read a full 4 x 4 board while allowing common visual separators."""

    normalised = unicodedata.normalize("NFC", raw_board.strip().lower())
    allowed_separators = frozenset(" \t\r\n,;|/")
    unexpected = sorted({
        character
        for character in normalised
        if not character.isalpha() and character not in allowed_separators
    })
    if unexpected:
        raise InputError("В конфигурации используйте только буквы, пробелы и переносы строк.")
    board = tuple(character for character in normalised if character.isalpha())
    if len(board) != CELL_COUNT:
        raise InputError(
            f"В конфигурации должно быть ровно 16 букв, сейчас их {len(board)}. "
            "Удобнее всего ввести 4 строки по 4 буквы."
        )
    return board


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

    def __init__(
        self,
        words: list[str],
        minimum_letter_cells: dict[str, int],
        deadline: float,
        maximum_letter_cells: dict[str, int] | None = None,
    ):
        self.words = words
        self.minimum_letter_cells = minimum_letter_cells
        minimum_total = sum(minimum_letter_cells.values())
        self.maximum_letter_cells = (
            maximum_letter_cells
            if maximum_letter_cells is not None
            else {
                letter: CELL_COUNT - (minimum_total - minimum)
                for letter, minimum in minimum_letter_cells.items()
            }
        )
        self.single_cell_letters = {
            letter
            for letter, maximum in self.maximum_letter_cells.items()
            if maximum == 1
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
        affected_words = {self.variable_word[variable] for variable in changed_variables}

        def narrow(variable: int, new_domain: int) -> bool:
            if new_domain == domains[variable]:
                return True
            domains[variable] = new_domain
            affected_words.add(self.variable_word[variable])
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

            # If the cell budget permits only one cell for this letter, all
            # of its occurrences are the same CSP variable in disguise.
            # Synchronising their domains turns the common 16-letter case
            # from dozens of position variables into 16 effective choices.
            letter = self.letters[variable]
            if letter in self.single_cell_letters:
                shared_domain = ALL_CELLS
                for same_letter_variable in self.letter_variables[letter]:
                    shared_domain &= domains[same_letter_variable]
                if not shared_domain:
                    return False
                for same_letter_variable in self.letter_variables[letter]:
                    if not narrow(same_letter_variable, shared_domain):
                        return False
                domain = shared_domain

            # Arc consistency for the two path neighbours of this position.
            supported_cells = self._neighbour_union(domain)
            for neighbour in self.adjacent_variables[variable]:
                if not narrow(neighbour, domains[neighbour] & supported_cells):
                    return False

            if domain & (domain - 1) or variable in propagated_singletons:
                continue
            propagated_singletons.add(variable)
            cell = domain.bit_length() - 1
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
        for word_index in affected_words:
            if not self._word_path_possible(self.word_variables[word_index], domains):
                return False
        return self._capacity_possible(domains, owners)

    def _choose_variable(self, domains: list[int]) -> int | None:
        candidates = []
        represented_letters: set[str] = set()
        for variable, domain in enumerate(domains):
            if not domain & (domain - 1):
                continue
            letter = self.letters[variable]
            if letter in self.single_cell_letters:
                if letter in represented_letters:
                    continue
                represented_letters.add(letter)
            candidates.append(variable)
        if not candidates:
            return None

        def priority(variable: int) -> tuple[int, int, int, int]:
            letter = self.letters[variable]
            group = (
                self.letter_variables[letter]
                if letter in self.single_cell_letters
                else [variable]
            )
            domain_size = domains[variable].bit_count()
            constrained_neighbours = {
                neighbour
                for member in group
                for neighbour in self.adjacent_variables[member]
            }
            adjacency_pressure = sum(
                CELL_COUNT + 1 - domains[neighbour].bit_count()
                for neighbour in constrained_neighbours
            )
            word_length = max(
                len(self.word_variables[self.variable_word[member]])
                for member in group
            )
            return domain_size, -adjacency_pressure, -len(group), -word_length

        return min(candidates, key=priority)

    def _ordered_cells(self, variable: int, domains: list[int], root: bool) -> list[int]:
        cells = list(_iter_cells(domains[variable]))
        if root and domains[variable] == ALL_CELLS:
            # The empty square has eight rotations/reflections.  Any solution
            # can move this first occurrence to one of these three cell orbits.
            cells = [cell for cell in ROOT_CELL_ORBITS if domains[variable] & (1 << cell)]

        letter = self.letters[variable]
        choice_variables = (
            self.letter_variables[letter]
            if letter in self.single_cell_letters
            else [variable]
        )
        word_variables = {
            other
            for member in choice_variables
            for other in self.word_variables[self.variable_word[member]]
        }
        constrained_neighbours = {
            neighbour
            for member in choice_variables
            for neighbour in self.adjacent_variables[member]
        }

        def score(cell: int) -> int:
            bit = 1 << cell
            adjacency_options = sum(
                (NEIGHBOUR_MASKS[cell] & domains[neighbour]).bit_count()
                for neighbour in constrained_neighbours
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


def _iter_candidate_subsets(
    words: list[str],
    maximum_size: int,
    deadline: float,
):
    """Yield cell-budget-feasible subsets in decreasing cardinality.

    The generator never materialises ``2 ** n`` subsets.  It constructs one
    candidate at a time and prunes a branch as soon as the per-letter maxima
    require more than 16 cells.  Words that share popular letters are tried
    first, which tends to find a feasible maximum candidate early.
    """

    valid_indices = [index for index, word in enumerate(words) if len(word) <= CELL_COUNT]
    requirements = [Counter(word) for word in words]
    word_frequency = Counter(letter for word in words for letter in set(word))

    def compatibility_key(index: int) -> tuple[float, int, int]:
        letters = requirements[index]
        rarity = sum(1 / word_frequency[letter] for letter in letters)
        return rarity, -len(words[index]), index

    ordered_indices = sorted(valid_indices, key=compatibility_key)
    upper_size = min(maximum_size, len(ordered_indices))
    visited_nodes = 0

    for target_size in range(upper_size, 0, -1):
        selected: list[int] = []
        required_counts: dict[str, int] = {}
        required_total = 0

        def visit(position: int):
            nonlocal required_total, visited_nodes
            visited_nodes += 1
            if visited_nodes % 1024 == 0 and time.perf_counter() >= deadline:
                raise SearchTimedOut

            selected_count = len(selected)
            remaining = len(ordered_indices) - position
            if selected_count == target_size:
                yield [words[index] for index in sorted(selected)]
                return
            if selected_count + remaining < target_size:
                return

            index = ordered_indices[position]
            changes: list[tuple[str, int]] = []
            added_cells = 0
            for letter, count in requirements[index].items():
                previous = required_counts.get(letter, 0)
                if count > previous:
                    changes.append((letter, previous))
                    added_cells += count - previous

            if required_total + added_cells <= CELL_COUNT:
                for letter, _ in changes:
                    required_counts[letter] = requirements[index][letter]
                required_total += added_cells
                selected.append(index)
                yield from visit(position + 1)
                selected.pop()
                required_total -= added_cells
                for letter, previous in changes:
                    if previous:
                        required_counts[letter] = previous
                    else:
                        del required_counts[letter]

            yield from visit(position + 1)

        yield from visit(0)


def _selection_metadata(all_words: list[str], selected_words: list[str], tested: int) -> dict:
    selected_set = set(selected_words)
    return {
        "input_count": len(all_words),
        "selected_count": len(selected_words),
        "selected_words": selected_words,
        "omitted_words": [word for word in all_words if word not in selected_set],
        "maximum_proven": True,
        "candidates_tested": tested,
    }


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
