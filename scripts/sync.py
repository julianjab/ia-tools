"""Sync ia-tools shared configs to an application repo via symlinks."""

from __future__ import annotations

import os
from pathlib import Path

import click


SYMLINK_MAP = {
    "agents": ".claude/agents/shared",
    "rules": ".claude/rules/shared",
    "skills": ".claude/skills/shared",
}


def create_symlink(source: Path, target: Path) -> str:
    """Create a symlink from target -> source. Returns status message."""
    if target.is_symlink():
        current = target.resolve()
        if current == source.resolve():
            return f"  [skip] {target} -> already linked"
        target.unlink()
        os.symlink(source, target)
        return f"  [update] {target} -> {source}"

    if target.exists():
        return f"  [skip] {target} -> already exists (not a symlink, skipping)"

    target.parent.mkdir(parents=True, exist_ok=True)
    os.symlink(source, target)
    return f"  [create] {target} -> {source}"


@click.command()
@click.argument("ia_tools_path", type=click.Path(exists=True, file_okay=False))
@click.argument("target_repo", type=click.Path(exists=True, file_okay=False))
def main(ia_tools_path: str, target_repo: str) -> None:
    """Sync ia-tools shared configs to a target app repo via symlinks.

    IA_TOOLS_PATH: Path to the ia-tools repository
    TARGET_REPO: Path to the target application repository
    """
    source = Path(ia_tools_path).resolve()
    target = Path(target_repo).resolve()

    click.echo(f"Syncing ia-tools → {target}\n")

    # Create symlinks for agents, rules, skills
    click.echo("Symlinks:")
    for src_dir, tgt_rel in SYMLINK_MAP.items():
        src = source / src_dir
        tgt = target / tgt_rel
        if not src.exists():
            click.echo(f"  [warn] Source {src} does not exist, skipping")
            continue
        msg = create_symlink(src, tgt)
        click.echo(msg)

    # Create .claude/.mcp.json with MCP server configs (if not exists)
    mcp_config_path = target / ".claude" / ".mcp.json"
    if not mcp_config_path.exists():
        mcp_config_path.parent.mkdir(parents=True, exist_ok=True)
        memory_server = source / "mcp-servers" / "memory" / "dist" / "index.js"
        conventions_server = source / "mcp-servers" / "conventions" / "dist" / "index.js"
        mcp_config = (
            "{\n"
            '  "mcpServers": {\n'
            '    "memory": {\n'
            '      "type": "stdio",\n'
            '      "command": "node",\n'
            f'      "args": ["{memory_server}"]\n'
            "    },\n"
            '    "conventions": {\n'
            '      "type": "stdio",\n'
            '      "command": "node",\n'
            f'      "args": ["{conventions_server}"]\n'
            "    }\n"
            "  }\n"
            "}\n"
        )
        mcp_config_path.write_text(mcp_config)
        click.echo(f"\nMCP config:")
        click.echo(f"  [create] {mcp_config_path}")
    else:
        click.echo(f"\nMCP config:")
        click.echo(f"  [skip] {mcp_config_path} already exists")

    click.echo(f"\nDone! Your app repo now has access to ia-tools shared configs.")
    click.echo(f"Add to your CLAUDE.md: @.claude/rules/shared/base.md")


if __name__ == "__main__":
    main()
