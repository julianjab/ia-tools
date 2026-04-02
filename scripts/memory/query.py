"""CLI for querying the ia-tools memory store."""

from __future__ import annotations

import json
from pathlib import Path

import click


def get_store_path() -> Path:
    return Path.home() / ".ia-tools" / "memory.jsonl"


def read_memories() -> list[dict]:
    path = get_store_path()
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().strip().split("\n") if line.strip()]


@click.group()
def main() -> None:
    """ia-tools memory CLI — query and manage agent memories."""


@main.command()
@click.argument("query")
@click.option("--project", "-p", default=None, help="Filter by project name")
@click.option("--limit", "-l", default=10, help="Max results")
def recall(query: str, project: str | None, limit: int) -> None:
    """Search memories by keyword."""
    memories = read_memories()
    query_lower = query.lower()
    words = query_lower.split()

    scored = []
    for m in memories:
        if project and m.get("project") != project:
            continue
        content_lower = m["content"].lower()
        tags_lower = [t.lower() for t in m.get("tags", [])]
        score = 0
        for word in words:
            if word in content_lower:
                score += 2
            if any(word in t for t in tags_lower):
                score += 3
        if query_lower in content_lower:
            score += 5
        if score > 0:
            scored.append((score, m))

    scored.sort(key=lambda x: -x[0])
    results = [m for _, m in scored[:limit]]

    if not results:
        click.echo("No memories found.")
        return

    for m in results:
        click.echo(f"\n[{m['type']}] {m['id'][:8]}...")
        click.echo(f"  {m['content'][:200]}")
        if m.get("tags"):
            click.echo(f"  tags: {', '.join(m['tags'])}")
        if m.get("project"):
            click.echo(f"  project: {m['project']}")


@main.command(name="list")
@click.option("--project", "-p", default=None, help="Filter by project")
@click.option("--tag", "-t", default=None, help="Filter by tag")
def list_memories(project: str | None, tag: str | None) -> None:
    """List all memories."""
    memories = read_memories()

    for m in memories:
        if project and m.get("project") != project:
            continue
        if tag and tag.lower() not in [t.lower() for t in m.get("tags", [])]:
            continue
        click.echo(f"[{m['type']}] {m['id'][:8]}  {m['content'][:100]}")


if __name__ == "__main__":
    main()
