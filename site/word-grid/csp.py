"""Exact constraint solver for assigning word positions to board cells."""

from __future__ import annotations

from collections import defaultdict, deque
from collections.abc import Callable
import time

from grid_model import (
    ALL_CELLS,
    CELL_COUNT,
    NEIGHBOUR_MASKS,
    ROOT_CELL_ORBITS,
    SearchTimedOut,
    SolutionLimitReached,
    _canonical_board,
    _iter_cells,
)


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

            # When a letter is allowed only one cell, all of its occurrences
            # are the same effective variable and can share one domain.
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

            for other in self.word_variables[self.variable_word[variable]]:
                if other != variable and not narrow(other, domains[other] & ~domain):
                    return False

            if len(propagated_singletons) % 32 == 0:
                self._check_deadline()

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
        """Visit every leaf, returning whether this subtree had a solution."""

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
        """Enumerate unique boards; return completion and stop reason."""

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
