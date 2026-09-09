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

## El pipeline: `/aiflow`

Los agentes solos no son el flujo. `rules/*.yaml` es, sacándole el mecanismo
de webhooks, una tabla de `(status × type × repos × labels) → agente + brief`,
y el transformador la emite como `pipeline.json` junto con las transiciones de
cada agente (`exits`) y la config del board.

La skill `/aiflow <issue>` la consume: lee la card, elige la ruta, despacha el
subagente con su brief y **escribe la transición de vuelta** en el board.

```bash
/aiflow la-haus/subscriptions#123      # corre hasta un gate humano
/aiflow #123 --step                    # una sola vuelta
/aiflow #123 --dry-run                 # qué haría, sin tocar nada
```

Escribir sobre un board compartido con el engine tiene tres guardas, todas
sacadas del propio `project.yaml`:

- **`Working` es un lock.** Es el `workingMarker`, el único guard
  anti-doble-dispatch que el engine tiene fuera de su RAM. Si dice `Yes`, la
  skill no despacha.
- **Los comentarios llevan `<!-- ia-flow:claude-code -->`.** Las reglas del
  engine filtran con `^(?![\s\S]*<!-- ia-flow:)`; sin la marca, un comentario
  nuestro lo despierta y arranca un ping-pong.
- **`Refined → Build` sigue siendo humano.** El loop para ahí, y también a las
  tres vueltas.

Lo que la tabla no puede resolver sola queda documentado en la skill: las
rutas `comment`/`pr_review`/`ci` necesitan un contexto que el board no tiene,
y `build-arrival` matchea sobre la transición (`from`/`to`), no sobre el
estado — se distingue por si ya hay rama y PR.

Las rutas `wait.resumed`/`wait.expired` no se emiten: son la contracara de
`pause_until`, que no existe fuera del engine.

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
