#!/usr/bin/env python3
"""Dependency-free structural checks for the static site and graph data."""

from __future__ import annotations

import json
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"


class AssetParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.references: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        attribute = "src" if tag in {"script", "img"} else "href" if tag in {"a", "link"} else None
        if attribute and values.get(attribute):
            self.references.append(values[attribute] or "")


def check_local_references() -> tuple[int, int]:
    html_files = sorted(SITE.rglob("*.html"))
    failures: list[str] = []
    reference_count = 0

    for html_file in html_files:
        parser = AssetParser()
        parser.feed(html_file.read_text(encoding="utf-8"))
        for raw_reference in parser.references:
            parsed = urlsplit(raw_reference)
            if parsed.scheme or parsed.netloc or not parsed.path or parsed.path.startswith(("#", "data:")):
                continue
            reference_count += 1
            target = (html_file.parent / unquote(parsed.path)).resolve()
            if parsed.path.endswith("/"):
                target /= "index.html"
            if not target.exists():
                failures.append(f"{html_file.relative_to(ROOT)} -> {raw_reference}")

    if failures:
        raise AssertionError("Broken local references:\n  " + "\n  ".join(failures))
    return len(html_files), reference_count


def check_graph() -> tuple[int, int, int]:
    graph_path = SITE / "anagrams" / "data" / "graph.json"
    graph = json.loads(graph_path.read_text(encoding="utf-8"))
    nodes = graph.get("nodes")
    edges = graph.get("edges")
    if not isinstance(nodes, list) or not isinstance(edges, list):
        raise AssertionError("graph.json must contain node and edge arrays")

    words: set[str] = set()
    for index, node in enumerate(nodes):
        if not isinstance(node, dict) or not {"id", "label", "frequency", "words"} <= node.keys():
            raise AssertionError(f"Invalid node at index {index}")
        if not node["words"]:
            raise AssertionError(f"Node {index} has no words")
        for word_entry in node["words"]:
            if not isinstance(word_entry, list) or len(word_entry) != 2:
                raise AssertionError(f"Invalid word entry in node {index}")
            word = word_entry[0]
            if word in words:
                raise AssertionError(f"Duplicate dictionary word: {word}")
            words.add(word)

    allowed_types = {"add", "replace"}
    seen_edges: set[tuple[int, int]] = set()
    for edge_index, edge in enumerate(edges):
        if not isinstance(edge, list) or len(edge) != 3:
            raise AssertionError(f"Invalid edge at index {edge_index}")
        first, second, edge_type = edge
        if not isinstance(first, int) or not isinstance(second, int) or not (0 <= first < len(nodes)) or not (0 <= second < len(nodes)):
            raise AssertionError(f"Out-of-range edge at index {edge_index}")
        if first == second or edge_type not in allowed_types:
            raise AssertionError(f"Invalid edge semantics at index {edge_index}")
        key = (min(first, second), max(first, second))
        if key in seen_edges:
            raise AssertionError(f"Duplicate edge between {key[0]} and {key[1]}")
        seen_edges.add(key)

    return len(nodes), len(edges), len(words)


def main() -> int:
    required = [
        SITE / "index.html",
        SITE / "anagrams" / "index.html",
        SITE / "word-route" / "index.html",
        ROOT / ".github" / "workflows" / "pages.yml",
    ]
    missing = [str(path.relative_to(ROOT)) for path in required if not path.exists()]
    if missing:
        raise AssertionError("Missing required files: " + ", ".join(missing))

    html_count, reference_count = check_local_references()
    node_count, edge_count, word_count = check_graph()
    print(f"OK: {html_count} HTML files, {reference_count} local references")
    print(f"OK: graph has {node_count} nodes, {edge_count} edges, {word_count} unique words")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (AssertionError, json.JSONDecodeError, OSError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
