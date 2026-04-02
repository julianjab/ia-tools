"""Evaluation runner for agent quality datasets.

Loads YAML eval datasets and can run them in dry-run mode (validation only)
or against an LLM (requires ANTHROPIC_API_KEY).
"""

from __future__ import annotations

from pathlib import Path

import click
import yaml


def load_dataset(path: Path) -> dict:
    """Load and validate an eval dataset from YAML."""
    content = yaml.safe_load(path.read_text())

    if not isinstance(content, dict):
        raise ValueError(f"Dataset must be a YAML mapping, got {type(content)}")

    required = {"name", "cases"}
    missing = required - set(content.keys())
    if missing:
        raise ValueError(f"Dataset missing required fields: {missing}")

    cases = content["cases"]
    if not isinstance(cases, list) or len(cases) == 0:
        raise ValueError("Dataset must have at least one case")

    for i, case in enumerate(cases):
        if "input" not in case or "criteria" not in case:
            raise ValueError(f"Case {i} missing 'input' or 'criteria'")

    return content


@click.command()
@click.argument("dataset", type=click.Path(exists=True, path_type=Path))
@click.option("--dry-run", is_flag=True, help="Only validate the dataset, don't run evals")
def main(dataset: Path, dry_run: bool) -> None:
    """Run an evaluation dataset against agent outputs.

    DATASET: Path to a YAML eval dataset file.
    """
    click.echo(f"Loading dataset: {dataset}")
    data = load_dataset(dataset)

    click.echo(f"  Name: {data['name']}")
    click.echo(f"  Cases: {len(data['cases'])}")

    if dry_run:
        click.echo("\n[dry-run] Dataset validation passed.")
        for i, case in enumerate(data["cases"]):
            case_id = case.get("id", f"case-{i}")
            tags = ", ".join(case.get("tags", []))
            click.echo(f"  [{case_id}] {len(case['criteria'])} criteria  tags: {tags}")
        return

    click.echo("\n[run] LLM evaluation not yet implemented.")
    click.echo("  Set ANTHROPIC_API_KEY and implement LLM-as-judge scoring.")
    click.echo("  Results will be saved to evals/results/ and optionally to LangSmith.")


if __name__ == "__main__":
    main()
