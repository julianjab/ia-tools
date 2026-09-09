#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6"]
# ///
"""Transforma los AgentDefinition YAML del engine de ia-flow en subagentes
`.md` de Claude Code.

Fuente:  la-haus/claw-agents → agents/ai-development-flow/config/projects/
         lahaus-ai-flow/agents/*.yaml
Destino: plugins/ai-development-flow/agents/*.md

La conversión es LOSSY por diseño: son dos runtimes distintos. El método
(`systemPrompts` + `prompt`) viaja casi 1:1; la activación por reglas del
board, las tools del engine y el `submit_output` tipado no tienen
equivalente y se traducen a instrucciones en prosa dentro de una sección
"Contexto de ejecución" que el agente lee ANTES del método.

Lo que el YAML no tiene (la `description` que usa Claude Code para elegir
subagente, el color, el maxTurns) vive a mano en `overlays/<id>.yaml` y
sobrevive a cada regeneración.

Uso:
    ./scripts/sync-agents.py                      # desde el clon local
    ./scripts/sync-agents.py --ref v1.4.0         # pinneado, vía gh
    ./scripts/sync-agents.py --check              # falla si hay drift
"""

from __future__ import annotations

import argparse
import difflib
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path
from typing import Any

import yaml

PLUGIN_DIR = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = Path(
    os.environ.get(
        "CLAW_AGENTS_DIR",
        Path.home() / "development/lahaus/agents/claw-agents",
    )
)
PROJECT_SUBPATH = "agents/ai-development-flow/config/projects/lahaus-ai-flow"
AGENTS_SUBPATH = f"{PROJECT_SUBPATH}/agents"
REPO = "la-haus/claw-agents"

# Los agentes se instalan a scope de usuario y conviven con los de otros
# plugins (`team-workflow` ya trae un `implementer`). El prefijo evita que dos
# subagentes distintos peleen por el mismo nombre.
NAME_PREFIX = "aiflow-"

# ── Mapeo de tools: engine → Claude Code ──────────────────────────────────
#
# Las del filesystem y el shell tienen equivalente directo. Las de GitHub no:
# el engine habla con la API por tools dedicadas, acá se hace con `gh` desde
# Bash, así que todas colapsan en Bash + una nota de traducción. Las que son
# puro mecanismo del engine (`pause_until`, `submit_output`) se caen.
TOOL_MAP: dict[str, str | None] = {
    "fs_read": "Read",
    "fs_list": "Glob",
    "fs_grep": "Grep",
    "fs_write": "Write",
    "fs_edit": "Edit",
    "bash_run": "Bash",
    "run_agent": "Agent",
    "pause_until": None,
    "submit_output": None,
}

# Tools del engine que son llamadas a la API de GitHub. Colapsan en Bash + gh;
# el texto es la instrucción concreta que reemplaza a la tool en el prompt.
GITHUB_TOOLS: dict[str, str] = {
    "update_issue_body": "`gh issue edit <n> --body-file <archivo>`",
    "list_sub_issues_brief": (
        "`gh issue list --search 'parent-issue:<owner>/<repo>#<n>' "
        "--json number,title,state,url`"
    ),
    "create_github_issue": "`gh issue create --title ... --body-file ...`",
    "add_to_project": "`gh project item-add <n> --owner <owner> --url <url>`",
    "mark_blocked_by": (
        "no hay equivalente en `gh`: dejalo escrito en el cuerpo del issue "
        "(`Blocked by #<n>`) y avisá en tu respuesta final"
    ),
    "reply_pr_review_thread": "`gh api` sobre `/pulls/<n>/comments/<id>/replies`",
    "resolve_pr_review_thread": (
        "`gh api graphql` con la mutation `resolveReviewThread`"
    ),
    "react_to_comment": (
        "`gh api -X POST /repos/<owner>/<repo>/issues/comments/<id>/reactions`"
    ),
}

MODEL_MAP: dict[str, str] = {
    "claude-opus-5": "opus",
    "claude-sonnet-5": "sonnet",
    "claude-haiku-4-5": "haiku",
}

OVERLAY_KEYS = {
    "skip",
    "shared_prompts",
    "reason",
    "description",
    "color",
    "model",
    "effort",
    "maxTurns",
    "tools_add",
    "tools_remove",
    "context_notes",
    "body_append",
}


class SyncError(Exception):
    pass


# ── Lectura de la fuente ──────────────────────────────────────────────────


def fetch_source(ref: str) -> Path:
    """Baja el tarball del repo a un temp dir y devuelve la raíz."""
    if not shutil.which("gh"):
        raise SyncError("--ref necesita el CLI `gh` instalado y autenticado.")
    tmp = Path(tempfile.mkdtemp(prefix="claw-agents-"))
    tarball = tmp / "src.tar.gz"
    proc = subprocess.run(
        ["gh", "api", f"repos/{REPO}/tarball/{ref}"],
        stdout=tarball.open("wb"),
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode != 0:
        raise SyncError(f"no pude bajar {REPO}@{ref}: {proc.stderr.decode().strip()}")
    with tarfile.open(tarball) as tf:
        tf.extractall(tmp, filter="data")
    roots = [p for p in tmp.iterdir() if p.is_dir()]
    if len(roots) != 1:
        raise SyncError(f"tarball inesperado: {roots}")
    return roots[0]


def resolve_ref(source: Path, ref: str | None) -> str:
    """Etiqueta de procedencia para el header de cada `.md`.

    Tiene que dar lo MISMO para el clon local parado en `main` que para
    `--ref main`: si no, `--check` desde el clon reporta drift por una línea de
    comentario y el chequeo deja de servir como gate.
    """
    if ref:
        return ref
    proc = subprocess.run(
        ["git", "-C", str(source), "rev-parse", "--abbrev-ref", "HEAD"],
        capture_output=True,
        text=True,
        check=False,
    )
    branch = proc.stdout.strip()
    return branch if proc.returncode == 0 and branch not in ("", "HEAD") else "local"


def load_definitions(source: Path) -> list[tuple[Path, dict[str, Any]]]:
    agents_dir = source / AGENTS_SUBPATH
    if not agents_dir.is_dir():
        raise SyncError(f"no existe {agents_dir}")
    out: list[tuple[Path, dict[str, Any]]] = []
    for path in sorted(agents_dir.glob("*.yaml")):
        docs = yaml.safe_load(path.read_text(encoding="utf-8"))
        if not isinstance(docs, list):
            raise SyncError(f"{path.name}: se esperaba una lista de agentes")
        for definition in docs:
            if not isinstance(definition, dict) or "id" not in definition:
                raise SyncError(f"{path.name}: entrada sin `id`")
            out.append((path, definition))
    if not out:
        raise SyncError(f"{agents_dir} no tiene agentes")
    return out


def load_shared_prompts(source: Path) -> str:
    """El `settings.systemPrompts` de `project.yaml`.

    El engine lo manda como system prompt a TODOS los agentes del proyecto,
    antes de los bloques propios de cada uno. Sin esto los agentes generados
    pierden lo transversal —responder en español, que el `CLAUDE.md` del repo
    gana sobre el prompt, delegar en los subagentes del repo, no mergear
    nunca, la referencia de validación por stack y la convención de commits—
    que sus prompts propios dan por sentado y no repiten.

    El primer bloque se descarta: es "You are Claude Code…", que acá ya lo
    dice el harness.
    """
    path = source / PROJECT_SUBPATH / "project.yaml"
    if not path.exists():
        raise SyncError(f"no existe {path}")
    project = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    blocks = ((project.get("settings") or {}).get("systemPrompts")) or []
    texts = [
        (b.get("text") or "").strip()
        for b in blocks
        if isinstance(b, dict)
        and not (b.get("text") or "").startswith("You are Claude")
    ]
    return "\n\n".join(t for t in texts if t)


def load_overlay(agent_id: str) -> dict[str, Any]:
    path = PLUGIN_DIR / "overlays" / f"{agent_id}.yaml"
    if not path.exists():
        raise SyncError(
            f"falta overlays/{agent_id}.yaml — Claude Code elige subagente por "
            "`description` y el YAML del engine no tiene ninguna. Creá el "
            "overlay (o marcá `skip: true` con su `reason`)."
        )
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    unknown = set(data) - OVERLAY_KEYS
    if unknown:
        raise SyncError(
            f"overlays/{agent_id}.yaml: claves desconocidas {sorted(unknown)}"
        )
    return data


# ── Traducción ────────────────────────────────────────────────────────────


def tool_names(definition: dict[str, Any]) -> list[str]:
    """Normaliza `tools` — mezcla strings sueltos y objetos `{name, allow, deny}`."""
    names: list[str] = []
    for entry in definition.get("tools") or []:
        if isinstance(entry, str):
            names.append(entry)
        elif isinstance(entry, dict) and "name" in entry:
            names.append(entry["name"])
        else:
            raise SyncError(f"tool ilegible en `{definition['id']}`: {entry!r}")
    return names


def translate_tools(
    definition: dict[str, Any], overlay: dict[str, Any]
) -> tuple[list[str], list[str]]:
    """Devuelve (tools de Claude Code, notas de traducción)."""
    engine_tools = tool_names(definition)
    mapped: list[str] = []
    notes: list[str] = []
    github_used: list[str] = []

    for tool in engine_tools:
        if tool in GITHUB_TOOLS:
            github_used.append(tool)
            mapped.append("Bash")
        elif tool in TOOL_MAP:
            target = TOOL_MAP[tool]
            if target:
                mapped.append(target)
            elif tool == "pause_until":
                notes.append(
                    "No existe `pause_until`. Si tu trabajo depende de algo que "
                    "todavía no pasó (un PR sin mergear, una decisión humana), "
                    "no esperes: terminá tu respuesta diciendo qué falta y quién "
                    "lo destraba."
                )
        else:
            notes.append(
                f"La tool `{tool}` del engine no tiene equivalente acá; "
                "resolvelo con las tools que sí tenés o reportalo."
            )

    if github_used:
        lines = "\n".join(
            f"  - `{t}` → {GITHUB_TOOLS[t]}" for t in sorted(set(github_used))
        )
        notes.append(
            "Las tools de GitHub del engine no existen: hacé lo mismo con el "
            f"CLI `gh` desde Bash.\n{lines}"
        )

    # Los agentes que navegaban el repo por el MCP de GitHub no declaran
    # ninguna `fs_*`: su lectura de código viene del MCP. Acá esa capacidad son
    # las tools locales, así que sin esto quedarían con `Bash` a secas y la
    # nota de "leelo con Read/Grep/Glob" les pediría algo que no tienen.
    if "github-mcp" in (definition.get("mcpCatalogIds") or []):
        mapped[:0] = ["Read", "Grep", "Glob"]

    mapped.extend(overlay.get("tools_add") or [])
    remove = set(overlay.get("tools_remove") or [])

    seen: set[str] = set()
    final = [t for t in mapped if t not in remove and not (t in seen or seen.add(t))]
    return final, notes


def context_notes(
    definition: dict[str, Any], tool_notes: list[str], overlay: dict[str, Any]
) -> list[str]:
    """Las diferencias de runtime que el agente tiene que leer antes del método."""
    notes: list[str] = [
        (
            "Corrés como subagente de Claude Code, no dentro del engine de "
            "ia-flow. El método de abajo se escribió para el engine; donde hable "
            "de un mecanismo que acá no existe, vale el resultado que busca, no "
            "el mecanismo. Estas son las diferencias:"
        )
    ]

    if "github-mcp" in (definition.get("mcpCatalogIds") or []):
        notes.append(
            "**Sí tenés checkout local.** El método dice que no lo tenés y que "
            "navegues el repo con el MCP de GitHub: ignoralo. Estás parado "
            "dentro del repo — leelo con Read, Grep y Glob, que es más barato y "
            "más fiel. No busques tools diferidas con `tool_search_tool_regex`."
        )

    notes.extend(tool_notes)

    # La deny-list de `bash_run` no tiene dónde aterrizar: Bash acá obedece a
    # los permisos del usuario, no al agente. Se traduce a una regla en prosa
    # para no perder la intención (credenciales, cloud, push destructivo).
    denies = [
        entry.get("deny") or []
        for entry in (definition.get("tools") or [])
        if isinstance(entry, dict) and entry.get("name") == "bash_run"
    ]
    if any(denies):
        notes.append(
            "El engine te acotaba el shell con una deny-list. Acá Bash obedece a "
            "los permisos del usuario, así que la regla es tuya: nada de "
            "credenciales ni entornos compartidos (`env`, `printenv`, `aws`, "
            "`kubectl`, `helm`, `terraform apply`, `sops`, `security`), nada "
            "destructivo (`rm -rf`, `git reset --hard`, `git clean`, "
            "`git push --force`) y nada de publicar paquetes."
        )

    if definition.get("requiresBranch"):
        notes.append(
            "El engine te garantizaba estar parado en la branch de la tarea. "
            "Acá verificalo vos con `git status` antes de tocar nada."
        )

    if definition.get("comment") == "issue":
        notes.append(
            "El engine publicaba tu resultado como comentario del issue. Acá "
            "devolvelo en tu respuesta final: quien te invocó decide qué "
            "publicar."
        )

    notes.extend(overlay.get("context_notes") or [])
    return notes


def output_contract(definition: dict[str, Any]) -> str | None:
    spec = definition.get("output")
    if not spec:
        return None
    lines = [
        (
            "En el engine esto viajaba por `submit_output` con tipos de verdad. "
            "Acá no hay canal estructurado: cerrá tu respuesta final con un "
            "bloque ```json``` con exactamente estos campos."
        ),
        "",
    ]
    for field, meta in spec.items():
        meta = meta or {}
        optional = " *(opcional)*" if meta.get("optional") else ""
        desc = " ".join(str(meta.get("description", "")).split())
        lines.append(f"- `{field}` — {meta.get('type', 'string')}{optional}: {desc}")
    return "\n".join(lines)


def exits_section(definition: dict[str, Any]) -> str | None:
    exits = definition.get("exits")
    if not exits:
        return None
    lines = [
        (
            "En el engine cada salida movía el issue en el board. Acá no hay "
            "board: terminá tu respuesta final nombrando explícitamente por cuál "
            "de estas salís y por qué."
        ),
        "",
    ]
    for name, value in exits.items():
        if isinstance(value, dict):
            target = value.get("set", "—")
            when = " ".join(str(value.get("when", "")).split())
            lines.append(f"- **{name}** → `{target}`. Cuándo: {when}")
        else:
            lines.append(f"- **{name}** → `{value}`")
    return "\n".join(lines)


def template_vars(*texts: str) -> list[str]:
    found: list[str] = []
    for text in texts:
        for match in re.findall(r"\{\{\s*([^}]+?)\s*\}\}", text or ""):
            if match not in found:
                found.append(match)
    return found


def demote_headings(text: str, levels: int = 2) -> str:
    """Baja los headings de la prosa embebida para que anide bajo la sección
    que la contiene. Los prompts del engine traen sus propios `# Rol — x` y
    `## Paso 0`; pegados tal cual chocarían con la estructura del `.md`.

    Los fences se saltan enteros: adentro un `#` es un comentario de shell,
    no un heading.
    """
    out: list[str] = []
    fence: str | None = None
    for line in text.split("\n"):
        stripped = line.lstrip()
        if fence:
            if stripped.startswith(fence):
                fence = None
        elif stripped.startswith(("```", "~~~")):
            fence = stripped[:3]
        elif match := re.match(r"^(#{1,6})(\s)", line):
            hashes = "#" * min(len(match.group(1)) + levels, 6)
            line = hashes + line[match.end(1) :]
        out.append(line)
    return "\n".join(out)


def yaml_scalar(value: str) -> str:
    """Escapa un valor de frontmatter para que sobreviva a cualquier parser."""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def render(
    definition: dict[str, Any],
    overlay: dict[str, Any],
    src_name: str,
    ref: str,
    shared: str = "",
) -> str:
    agent_id = definition["id"]
    provider_config = definition.get("providerConfig") or {}

    tools, tool_notes = translate_tools(definition, overlay)

    model = overlay.get("model") or MODEL_MAP.get(provider_config.get("model", ""))
    effort = overlay.get("effort") or provider_config.get("effort")

    fm = [
        "---",
        "# Generado por scripts/sync-agents.py — NO editar a mano.",
        f"# Fuente:  {AGENTS_SUBPATH}/{src_name} @ {ref}",
        f"# A mano:  overlays/{agent_id}.yaml",
        f"name: {NAME_PREFIX}{agent_id}",
        f"description: {yaml_scalar(' '.join(overlay['description'].split()))}",
    ]
    if model:
        fm.append(f"model: {model}")
    if effort:
        fm.append(f"effort: {effort}")
    if overlay.get("color"):
        fm.append(f"color: {overlay['color']}")
    if overlay.get("maxTurns"):
        fm.append(f"maxTurns: {overlay['maxTurns']}")
    if tools:
        fm.append(f"tools: {', '.join(tools)}")
    fm.append("---")

    raw_system = (definition.get("systemPrompts") or [{}])[0].get("text", "").strip()
    raw_prompt = (definition.get("prompt") or "").strip()
    system = demote_headings(raw_system)
    prompt = demote_headings(raw_prompt)

    body = [f"# {NAME_PREFIX}{agent_id}", "", "## Contexto de ejecución", ""]
    body.append("\n\n".join(context_notes(definition, tool_notes, overlay)))
    if shared and overlay.get("shared_prompts", True):
        body += [
            "",
            "## Reglas del pipeline",
            "",
            (
                "Valen para todos los pasos del pipeline, no solo para vos, y "
                "ganan sobre el método de abajo cuando choquen."
            ),
            "",
            demote_headings(shared),
        ]

    body += ["", "## Método", "", system]

    if prompt:
        body += ["", "## Encargo", "", prompt]

    variables = template_vars(raw_system, raw_prompt)
    if variables:
        body += [
            "",
            "## Lo que te tiene que dar quien te invoca",
            "",
            (
                "El engine interpolaba estas variables antes de mandarte el "
                "encargo. Acá llegan en el prompt de quien te invoca; si alguna "
                "falta, pedila antes de empezar en vez de asumirla."
            ),
            "",
        ]
        body += [f"- `{{{{{v}}}}}`" for v in variables]

    contract = output_contract(definition)
    if contract:
        body += ["", "## Contrato de salida", "", contract]

    exits = exits_section(definition)
    if exits:
        body += ["", "## Cómo terminar", "", exits]

    if overlay.get("body_append"):
        body += ["", overlay["body_append"].strip()]

    return "\n".join(fm) + "\n\n" + "\n".join(body).strip() + "\n"


# ── Orquestación ──────────────────────────────────────────────────────────


def build(source: Path, ref: str) -> tuple[dict[str, str], list[str]]:
    generated: dict[str, str] = {}
    skipped: list[str] = []
    shared = load_shared_prompts(source)
    for path, definition in load_definitions(source):
        agent_id = definition["id"]
        overlay = load_overlay(agent_id)
        if overlay.get("skip"):
            skipped.append(f"{agent_id} ({overlay.get('reason', 'sin motivo')})")
            continue
        if not overlay.get("description"):
            raise SyncError(f"overlays/{agent_id}.yaml: falta `description`")
        generated[f"{NAME_PREFIX}{agent_id}.md"] = render(
            definition, overlay, path.name, ref, shared
        )
    return generated, skipped


def without_provenance(text: str) -> str:
    """El `.md` sin la línea de procedencia.

    `--check` pregunta si el CONTENIDO quedó viejo, y el ref no es contenido:
    el mismo commit regenerado desde un clon parado en una rama feature da un
    header distinto y un diff idéntico. Compararlo haría fallar el gate por
    dónde tenías parado el clon.
    """
    return "\n".join(
        line for line in text.split("\n") if not line.startswith("# Fuente:")
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--ref", help=f"ref de {REPO} a bajar con gh (ignora --source)")
    parser.add_argument("--out", type=Path, default=PLUGIN_DIR / "agents")
    parser.add_argument(
        "--check",
        action="store_true",
        help="no escribe; sale 1 si lo generado difiere de lo commiteado",
    )
    args = parser.parse_args()

    try:
        source = fetch_source(args.ref) if args.ref else args.source
        generated, skipped = build(source, resolve_ref(source, args.ref))
    except SyncError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    args.out.mkdir(parents=True, exist_ok=True)
    drift = False

    for name, content in sorted(generated.items()):
        target = args.out / name
        current = target.read_text(encoding="utf-8") if target.exists() else ""
        same = (
            without_provenance(current) == without_provenance(content)
            if args.check
            else current == content
        )
        if same:
            print(f"  = {name}")
            continue
        drift = True
        if args.check:
            print(f"  ≠ {name}")
            sys.stdout.writelines(
                difflib.unified_diff(
                    current.splitlines(keepends=True),
                    content.splitlines(keepends=True),
                    fromfile=f"a/{name}",
                    tofile=f"b/{name}",
                )
            )
        else:
            target.write_text(content, encoding="utf-8")
            print(f"  {'~' if current else '+'} {name}")

    for stale in sorted(args.out.glob("*.md")):
        if stale.name not in generated:
            drift = True
            if args.check:
                print(f"  - {stale.name} (sobra)")
            else:
                stale.unlink()
                print(f"  - {stale.name}")

    for entry in skipped:
        print(f"  · skip {entry}")

    if args.check:
        print("drift" if drift else "sin drift")
        return 1 if drift else 0
    print(f"{len(generated)} agentes en {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
