"""Branch-and-bound candidate generation for maximum word subsets."""

from __future__ import annotations

from collections import Counter
import time

from grid_model import CELL_COUNT, SearchTimedOut


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
