---
name: aiflow
description: >
  Corre el pipeline de ia-flow (refine → build → review) sobre un issue del
  board, desde esta sesión: lee la card, elige el agente que le corresponde,
  lo despacha con su brief y escribe la transición de vuelta en el board.
  Usalo cuando pidan "corré el pipeline sobre el issue X", "refiná/implementá/
  revisá esta tarea con los agentes de ia-flow", o "seguí el flujo de esta
  card". Ejemplos: `/aiflow la-haus/subscriptions#123`, `/aiflow #123 --step`,
  `/aiflow --dry-run`.
argument-hint: "[owner/repo#N | url] [--step] [--dry-run]"
disable-model-invocation: false
---

## aiflow — el pipeline, desde esta sesión

Hace lo que el engine de ia-flow hace por webhook, pero en modo *pull* y sobre
tu checkout local: elegir agente, despacharlo, escribir el resultado en el
board.

**Por qué existe:** el fallback en contenedor del engine solo trae `uv` +
CPython, así que para los repos Flutter, Ruby, Terraform y yarn entrega sin
validar. Corriendo acá el toolchain está de verdad.

**Dos archivos son la fuente de todo lo que sigue**, ambos generados desde
`la-haus/claw-agents` — no hardcodees nada que salga de ellos:

- `${CLAUDE_PLUGIN_ROOT}/pipeline.json` — la tabla de ruteo, las transiciones
  de cada agente y la config del board.
- `${CLAUDE_PLUGIN_ROOT}/scripts/board.py` — leer y escribir la card.

---

### Reglas que no se negocian

1. **El campo `Working` es un lock compartido con el engine.** Es el único
   guard anti-doble-dispatch que sobrevive al proceso. Si al leer la card ya
   dice `Yes`, **parás**: hay otro runner (o el engine) trabajando ese issue.
   No lo pisás "porque parece viejo".
2. **Toda salida tuya al issue o al PR lleva `<!-- ia-flow:claude-code -->`**
   en el cuerpo. Las reglas de comentarios del engine filtran con
   `^(?![\s\S]*<!-- ia-flow:)`: un comentario tuyo sin la marca despierta al
   engine, que comenta, que te despierta a vos. Ping-pong infinito.
3. **`Refined → Build` es aprobación humana.** El loop se detiene ahí y avisa.
   Nunca movés una card a `Build` vos.
4. **Nunca mergeás un PR ni sugerís mergearlo.**
5. **Una card con label `blocked` no se toca** — es el `baseWhen` del
   proyecto, vale para todas las reglas.

---

### Pasos

#### 1 — Resolver el issue

Del argumento (`owner/repo#N` o url). Sin argumento: sacalo de la rama actual
(`git branch --show-current`, las ramas del pipeline llevan el número) o del
PR abierto (`gh pr view --json body,url`). Si no podés resolverlo sin
adivinar, preguntá.

#### 2 — Leer la card

```bash
uv run "${CLAUDE_PLUGIN_ROOT}/scripts/board.py" show <issue>
```

Devuelve `issue.labels` y `fields` (`Status`, `Task Type`, `Working`,
`Repository`). Con eso:

- `Working == "Yes"` → **stop** (regla 1). Reportá quién podría tenerlo.
- `blocked` en labels → **stop** (regla 5).
- Issue cerrado → **stop**, no hay pipeline sobre algo cerrado.

#### 3 — Elegir la ruta

De `pipeline.json`, filtrá `routes` con `trigger == "board"` y evaluá sus
`when` **en orden de `position`** contra lo que leíste. La primera que matchea
gana y **no seguís evaluando** (el engine las marca `exclusive: true`).

Los campos del `when` mapean así: `item.status` → `fields.Status`;
`item.type` / `task_type` → `fields["Task Type"]` en minúscula;
`item.repos` → `issue.repo`; `item.labels` → `issue.labels`. Los operadores
son `=`, `!=`, `$matches`, `$not_null`.

**Las rutas que miran la transición, no el estado.** `build-arrival` matchea
con `to = Build` y `from != Review`: eso es el salto entre columnas, y el
board solo te dice dónde está la card **ahora**. Distinguí por el trabajo
publicado, que es lo que las dos rutas de `Build` realmente separan:

- No hay rama de la task ni PR abierto → es una **llegada**: usá el brief de
  `build-arrival` ("primera corrida, implementá el PRD desde cero").
- Ya hay rama con commits o un PR → es una **reentrada**: usá el brief de
  `build-reentry` ("empezá por las novedades, no por el PRD").

Sin esa distinción `build-reentry` gana siempre por posición y le mandarías a
un implementer que arranca de cero un brief que le dice que atienda trabajo
previo que no existe.

Las rutas `trigger: "comment"`, `"pr_review"` y `"ci"` necesitan un contexto
que el board no tiene. Usalas solo si el usuario te dio ese contexto (un
comentario, un review, un run de CI rojo). En el engine el paso previo lo hace
`comment-triage`; acá ese juicio —¿este comentario pide un cambio real?— lo
hacés vos antes de despachar, y si no lo pide, no despachás.

Si ninguna ruta matchea: decilo con el estado que leíste y parás. No inventes
un agente.

#### 4 — Tomar el lock

```bash
uv run "${CLAUDE_PLUGIN_ROOT}/scripts/board.py" set <issue> --field Working --value Yes
```

Con `--dry-run` en los argumentos de la skill, pasáselo también al script y
**no despaches**: mostrá la ruta elegida, el brief renderizado y las
transiciones que aplicarías.

A partir de acá, **pase lo que pase, el lock se libera** (paso 7) — también si
el agente falla o si el usuario interrumpe.

#### 5 — Despachar el agente

Invocá el subagente que dice la ruta (`steps[].agent`) con el Agent tool. El
prompt es el `brief` de la ruta **más** las variables que el `.md` del agente
declara en "Lo que te tiene que dar quien te invoca". Armalas así:

| variable | de dónde |
| --- | --- |
| `task.title`, `task.description` | `gh issue view <n> --json title,body` |
| `task.repos` | `issue.repo` |
| `task.issueUrl`, `task.id` | de `board.py show` |
| `task.branch` | la rama de la task; si no existe, creala con la convención del repo antes de despachar |
| `task.comments` | `gh issue view <n> --comments`, solo lo posterior a la última corrida |

Si el `brief` trae `{{steps.triage.output.summary}}`, reemplazalo por tu
propio resumen del comentario que estás atendiendo.

#### 6 — Aplicar la transición

El agente termina nombrando una salida (su sección "Cómo terminar"). Buscala
en `pipeline.json` → `agents[<agente>].exits`. La sintaxis del valor:

- Un nombre suelto (`Refined`, `Review`, `Build`) → `Status`.
- `$set:Labels=+x,-y` → agregar/sacar labels.
- `$set:Task Type=Technical` → ese campo.
- `{set: ..., when: ...}` → el `set`; el `when` es la condición que el agente
  ya evaluó al elegir la salida.

```bash
uv run "${CLAUDE_PLUGIN_ROOT}/scripts/board.py" set   <issue> --field Status --value Review
uv run "${CLAUDE_PLUGIN_ROOT}/scripts/board.py" label <issue> --add reviewed
```

Ojo con `agents[<agente>].onProcess`: se aplica **antes** de correr, no al
salir. El implementer se saca `reviewed` y `ci-checked` al arrancar, y por eso
su push vuelve a pasar por el reviewer.

Si el agente no nombró una salida clara, **no adivines**: dejá la card como
está, liberá el lock y reportá qué devolvió.

#### 7 — Liberar el lock y decidir si seguís

```bash
uv run "${CLAUDE_PLUGIN_ROOT}/scripts/board.py" clear <issue> --field Working
```

Después de la transición, volvé al paso 2 con el estado nuevo **salvo** que:

- La transición dejó la card en `Refined` → **parás**: gate humano (regla 3).
- La transición puso `blocked` → **parás**.
- El usuario pasó `--step` → una sola vuelta, siempre.
- Ya diste **tres** vueltas en esta invocación → parás y reportás. Un ciclo
  `Build ↔ Review` que no converge es un problema para un humano, no para
  otra vuelta.

---

### Reporte final

Siempre, aunque hayas parado temprano:

- la ruta elegida (id de la regla) y por qué matcheó;
- qué agente corrió y con qué salida volvió;
- **cada escritura que hiciste en el board**, campo por campo;
- dónde quedó la card y qué falta para que avance.
