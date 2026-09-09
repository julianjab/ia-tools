#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Lee y escribe la card de un issue en el GitHub Project del pipeline.

Existe para que la skill no tenga que improvisar GraphQL en cada corrida: los
campos del board (Status, Task Type, Working, Labels) son single-select de
ProjectV2 y se escriben por id de opción, no por nombre.

    ./board.py show la-haus/subscriptions#123
    ./board.py set  la-haus/subscriptions#123 --field Status --value Build
    ./board.py set  la-haus/subscriptions#123 --field Working --value Yes
    ./board.py clear la-haus/subscriptions#123 --field Working
    ./board.py label la-haus/subscriptions#123 --add blocked --remove reviewed

`--dry-run` imprime lo que haría sin tocar nada.

Toda escritura es sobre el board de producción, compartido con el engine. El
guard de concurrencia es el campo `Working` (el `workingMarker` de
`project.yaml`): es el único que sobrevive al proceso, así que respetarlo es
lo que evita que dos runners despachen el mismo issue.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from typing import Any

ISSUE_RE = re.compile(
    r"^(?:https?://github\.com/)?(?P<owner>[\w.-]+)/(?P<repo>[\w.-]+)"
    r"(?:/issues/|#)(?P<number>\d+)/?$"
)

ITEM_QUERY = """
query($owner:String!, $repo:String!, $number:Int!) {
  repository(owner:$owner, name:$repo) {
    issue(number:$number) {
      id title url state
      labels(first:50) { nodes { name } }
      projectItems(first:10) {
        nodes {
          id
          project { id number title }
          fieldValues(first:40) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2SingleSelectField { name } }
              }
              ... on ProjectV2ItemFieldTextValue {
                text
                field { ... on ProjectV2Field { name } }
              }
            }
          }
        }
      }
    }
  }
}
"""

FIELDS_QUERY = """
query($project:ID!) {
  node(id:$project) {
    ... on ProjectV2 {
      fields(first:50) {
        nodes {
          ... on ProjectV2SingleSelectField {
            id name options { id name }
          }
          ... on ProjectV2FieldCommon { id name }
        }
      }
    }
  }
}
"""

SET_MUTATION = """
mutation($project:ID!, $item:ID!, $field:ID!, $option:String!) {
  updateProjectV2ItemFieldValue(input:{
    projectId:$project, itemId:$item, fieldId:$field,
    value:{ singleSelectOptionId:$option }
  }) { projectV2Item { id } }
}
"""

CLEAR_MUTATION = """
mutation($project:ID!, $item:ID!, $field:ID!) {
  clearProjectV2ItemFieldValue(input:{
    projectId:$project, itemId:$item, fieldId:$field
  }) { projectV2Item { id } }
}
"""


class BoardError(Exception):
    pass


def gh_graphql(query: str, **variables: Any) -> dict[str, Any]:
    cmd = ["gh", "api", "graphql", "-f", f"query={query}"]
    for key, value in variables.items():
        # -F tipa (números, booleanos, ids); -f manda string siempre.
        cmd += ["-F" if isinstance(value, int) else "-f", f"{key}={value}"]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise BoardError(f"gh api graphql falló: {proc.stderr.strip()}")
    payload = json.loads(proc.stdout)
    if payload.get("errors"):
        raise BoardError(f"GraphQL: {payload['errors']}")
    return payload["data"]


def parse_issue(ref: str) -> tuple[str, str, int]:
    match = ISSUE_RE.match(ref.strip())
    if not match:
        raise BoardError(
            f"no entiendo `{ref}` — usá `owner/repo#123` o la url del issue"
        )
    return match["owner"], match["repo"], int(match["number"])


def load_item(ref: str, project_number: int | None) -> dict[str, Any]:
    owner, repo, number = parse_issue(ref)
    data = gh_graphql(ITEM_QUERY, owner=owner, repo=repo, number=number)
    issue = (data.get("repository") or {}).get("issue")
    if not issue:
        raise BoardError(f"no existe {owner}/{repo}#{number}")

    items = issue["projectItems"]["nodes"]
    if project_number is not None:
        items = [i for i in items if i["project"]["number"] == project_number]
    if not items:
        raise BoardError(
            f"{owner}/{repo}#{number} no está en el project "
            f"{project_number if project_number is not None else '(ninguno)'}"
        )
    if len(items) > 1:
        raise BoardError(
            "el issue está en varios projects; pasá --project <número> para elegir"
        )
    item = items[0]

    fields: dict[str, str] = {}
    for value in item["fieldValues"]["nodes"]:
        field = value.get("field") or {}
        if not field.get("name"):
            continue
        fields[field["name"]] = value.get("name") or value.get("text") or ""

    return {
        "issue": {
            "id": issue["id"],
            "url": issue["url"],
            "title": issue["title"],
            "state": issue["state"],
            "owner": owner,
            "repo": repo,
            "number": number,
            "labels": [n["name"] for n in issue["labels"]["nodes"]],
        },
        "item": {"id": item["id"], "project": item["project"]},
        "fields": fields,
    }


def resolve_field(project_id: str, name: str) -> dict[str, Any]:
    data = gh_graphql(FIELDS_QUERY, project=project_id)
    for field in (data["node"] or {}).get("fields", {}).get("nodes", []):
        if field.get("name") == name:
            return field
    raise BoardError(f"el project no tiene un campo `{name}`")


def cmd_show(args: argparse.Namespace) -> int:
    print(json.dumps(load_item(args.issue, args.project), indent=2, ensure_ascii=False))
    return 0


def cmd_set(args: argparse.Namespace) -> int:
    state = load_item(args.issue, args.project)
    field = resolve_field(state["item"]["project"]["id"], args.field)
    options = {o["name"]: o["id"] for o in field.get("options") or []}
    if not options:
        raise BoardError(f"`{args.field}` no es single-select; no sé escribirlo")
    if args.value not in options:
        raise BoardError(
            f"`{args.value}` no es una opción de `{args.field}`. "
            f"Hay: {', '.join(options)}"
        )

    actual = state["fields"].get(args.field, "")
    if actual == args.value:
        print(f"= {args.field} ya está en `{args.value}`")
        return 0
    if args.dry_run:
        print(f"[dry-run] {args.field}: `{actual}` → `{args.value}`")
        return 0

    gh_graphql(
        SET_MUTATION,
        project=state["item"]["project"]["id"],
        item=state["item"]["id"],
        field=field["id"],
        option=options[args.value],
    )
    print(f"✓ {args.field}: `{actual}` → `{args.value}`")
    return 0


def cmd_clear(args: argparse.Namespace) -> int:
    state = load_item(args.issue, args.project)
    field = resolve_field(state["item"]["project"]["id"], args.field)
    actual = state["fields"].get(args.field, "")
    if not actual:
        print(f"= {args.field} ya está vacío")
        return 0
    if args.dry_run:
        print(f"[dry-run] {args.field}: `{actual}` → (vacío)")
        return 0
    gh_graphql(
        CLEAR_MUTATION,
        project=state["item"]["project"]["id"],
        item=state["item"]["id"],
        field=field["id"],
    )
    print(f"✓ {args.field}: `{actual}` → (vacío)")
    return 0


def cmd_label(args: argparse.Namespace) -> int:
    owner, repo, number = parse_issue(args.issue)
    target = f"{owner}/{repo}"
    cmd = ["gh", "issue", "edit", str(number), "--repo", target]
    for label in args.add or []:
        cmd += ["--add-label", label]
    for label in args.remove or []:
        cmd += ["--remove-label", label]
    if len(cmd) == 6:
        raise BoardError("pasá al menos un --add o un --remove")
    if args.dry_run:
        print(f"[dry-run] {' '.join(cmd)}")
        return 0
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise BoardError(f"gh issue edit falló: {proc.stderr.strip()}")
    print(f"✓ labels +{args.add or []} -{args.remove or []}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--project",
        type=int,
        default=119,
        help="número del project (default: 119, el del pipeline)",
    )
    subs = parser.add_subparsers(dest="cmd", required=True)

    show = subs.add_parser("show", help="estado de la card, en JSON")
    show.add_argument("issue")
    show.set_defaults(func=cmd_show)

    setter = subs.add_parser("set", help="escribe un campo single-select")
    setter.add_argument("issue")
    setter.add_argument("--field", required=True)
    setter.add_argument("--value", required=True)
    setter.set_defaults(func=cmd_set)

    clear = subs.add_parser("clear", help="vacía un campo")
    clear.add_argument("issue")
    clear.add_argument("--field", required=True)
    clear.set_defaults(func=cmd_clear)

    label = subs.add_parser("label", help="agrega/saca labels del issue")
    label.add_argument("issue")
    label.add_argument("--add", action="append")
    label.add_argument("--remove", action="append")
    label.set_defaults(func=cmd_label)

    args = parser.parse_args()
    try:
        return args.func(args)
    except BoardError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
