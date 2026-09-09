# ai-development-flow

Los agentes del pipeline de [`la-haus/claw-agents`][src] disponibles como
subagentes de Claude Code, en cualquier repo.

La fuente de verdad sigue siendo el YAML del engine. Acá no se edita ningún
`.md`: se corre el transformador.

## Uso

```bash
uv run scripts/sync-agents.py              # desde el clon local de claw-agents
uv run scripts/sync-agents.py --ref v1.4.0 # pinneado a un tag, vía gh
uv run scripts/sync-agents.py --check      # sale 1 si agents/ quedó viejo
```

El clon local se busca en `$CLAW_AGENTS_DIR`, con default
`~/development/lahaus/agents/claw-agents`.

## Qué hace la transformación

| Engine (`AgentDefinition`) | Subagente `.md` |
| --- | --- |
| `systemPrompts[0].text` | `## Método` (headings bajados 2 niveles) |
| `prompt` | `## Encargo`, con sus `{{task.*}}` intactas |
| `providerConfig.model` / `effort` | `model:` / `effort:` del frontmatter |
| `fs_read/list/grep/write/edit` | `Read`, `Glob`, `Grep`, `Write`, `Edit` |
| `bash_run` (+ deny-list) | `Bash` + la deny-list traducida a prosa |
| tools de GitHub | `Bash` + el `gh` equivalente, tool por tool |
| `mcpCatalogIds: github-mcp` | nota: acá **sí** hay checkout local |
| `output` + `submit_output` | `## Contrato de salida` (bloque ```json```) |
| `exits` | `## Cómo terminar` |
| `pause_until`, `run_agent`, `comment` | notas de traducción |
| activación por regla del board | **no traduce** — la `description` va a mano |

Todo lo que el YAML no puede darte vive en `overlays/<id>.yaml` y sobrevive a
cada regeneración: `description` (obligatoria — es como Claude Code elige
subagente), `color`, `maxTurns`, overrides de modelo y tools, notas extra de
contexto, y `skip: true` para los agentes que solo tienen sentido dentro del
engine.

## Lo que se pierde

- **Los comentarios `#` del YAML** (~20% de esos archivos, y es el rationale
  denso). PyYAML los descarta y no hay dónde ponerlos sin meterlos al prompt.
  Para entender *por qué* un agente hace lo que hace, la fuente sigue siendo
  el YAML.
- **El tipado de `submit_output`**: acá es un bloque ```json``` por convención.
- **`pause_until`**: no hay forma de suspender un subagente sin retener el turno.
- **La activación**: en el engine la dispara una regla del board con su
  `brief`; acá la elige el modelo principal por `description`.

Los agentes se publican con prefijo `aiflow-` para no chocar con los de
`team-workflow` (que ya trae un `implementer`).

`comment-triage` no se genera: es un gate de webhook del engine, sin regla del
board no tiene a quién despachar.

[src]: https://github.com/la-haus/claw-agents/tree/main/agents/ai-development-flow/config/projects/lahaus-ai-flow/agents
