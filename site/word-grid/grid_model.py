"""Board geometry, input normalisation, and cheap problem reductions."""

from __future__ import annotations

from collections import Counter, defaultdict
import re
import unicodedata


GRID_SIDE = 4
CELL_COUNT = GRID_SIDE * GRID_SIDE
ALL_CELLS = (1 << CELL_COUNT) - 1
ROOT_CELL_ORBITS = (0, 1, 5)  # corner, non-corner edge, inner cell
MAX_WORDS = 80
MAX_ESSENTIAL_POSITIONS = 320
WORD_SPLITTER = re.compile(r"[\n,;]+")


class SearchTimedOut(Exception):
    """Raised when a bounded browser search reaches its deadline."""


class SolutionLimitReached(Exception):
    """Raised after the configured number of unique boards was collected."""


class InputError(ValueError):
    """Raised when the submitted word list cannot be interpreted."""


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
    """Return the minimum number of cells required for every letter."""

    required: dict[str, int] = defaultdict(int)
    for word in words:
        for letter, count in Counter(word).items():
            required[letter] = max(required[letter], count)
    return dict(required)


def _essential_words(words: list[str]) -> list[str]:
    """Drop words guaranteed by a longer word or its reverse."""

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
