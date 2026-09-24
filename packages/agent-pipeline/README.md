# @ia-tools/agent-pipeline

Harness domain-agnostic para componer agentes en pipelines que reaccionan a eventos.
No sabe nada de GitHub, Slack ni viajes — sólo conoce `DomainEvent`, `Runnable`, `Agent`,
`Pipeline` y `Engine`. Cada app que lo use trae su propio conector de entrada (webhook,
Socket Mode, un cron) que traduce su mundo a `DomainEvent`, y sus propios `Provider`s
(implementaciones concretas de LLM) para los agentes que declara.

Nace de auditar `ia-flow-worktrees/v2-platform/packages/engine-v2` (el motor de pipelines
de ia-flow): el patrón central — `EventBus` → `Pipeline` (matchea por `on`/`when`) → cadena
de `do[]` donde cada paso ve `ctx.steps` de TODOS los pasos anteriores, no sólo el
inmediato — es exactamente lo que hace falta acá. `AgentDefinitionProps`/`Agent` también
espejan la forma real de `engine-v2/src/engine/Agent.ts` a propósito. Lo que se dejó afuera:

- **`Task`/`Project`/`Repo`** — modelan un issue de GitHub con status/PRD/comments/PRs.
  Acá `event.scope` es `Record<string, unknown>` libre: cada dominio pone las claves que
  necesita (`{ owner, repo, issueNumber }`, `{ workspace, channel }`, `{ tripId }`).
- **`Execution`/pausa-y-reanudación de un run largo, capacidad/slots** — complejidad real
  (`run_checkpoints`, reanudar la conversación exacta de un provider, límites de concurrencia)
  que no vale la pena portar hasta que un caso de uso concreto la necesite. Un `Provider.run`
  acá es sólo una `Promise` — un provider asíncrono (lanza un trabajo y se entera de que
  terminó por un canal aparte, como el `TmuxClaudeProvider` de ia-flow) la mantiene pendiente
  el tiempo que haga falta, sin que el harness tenga que saber la diferencia.
- **`ScriptAction`** (correr un script de shell) — reemplazado por `FunctionAction`, que
  corre una función TS del proceso. Sin shell de por medio no hay comandos arbitrarios que
  allow-listear.
- **`HttpAction.url` con interpolación de secretos** — el README de engine-v2 documenta ese
  riesgo (`${SECRETO}` sin allow-list de host) como conocido y no resuelto. Acá `HttpAction`
  no interpola nada: los secretos van en `headers`/`body` ya resueltos por código, nunca
  parseados desde un string de config.

## Instalar (dentro del monorepo)

```bash
pnpm --filter @ia-tools/agent-pipeline build
pnpm --filter @ia-tools/agent-pipeline test
```

Para usarlo desde otra app del monorepo: `"@ia-tools/agent-pipeline": "workspace:*"` en su
`package.json`. Para usarlo desde un repo por fuera de `ia-tools` (vamos, accountant, …):
`npm pack` este paquete o publicalo a un registry privado — no tiene dependencias runtime.

## Las piezas

```
DomainEvent   { type, payload, scope?, occurredAt, depth }   — un evento crudo, sin negocio
Runnable      { id?, when?, continueOnError?, run(ctx) }      — lo que vive en Pipeline.do[]
Agent         Runnable respaldado por un LLM (config + Provider) — ver más abajo
Condition     { field, op, value, logic }                    — un `when` puro sobre un payload
Pipeline      { on, when?, scope?, exclusive?, do: Runnable[] } — matchea eventos, corre su cadena
Engine        dispatch(event) contra el roster de Pipeline    — el orquestador
EventBus      publish/subscribe in-process                    — pega todo
```

`Pipeline.do[]` es homogéneo: `EmitAction` (publica un evento derivado), `HttpAction` (llama
una API), `FunctionAction` (corre código TS con el contexto completo) y `Agent` (corre un LLM)
son todos `Runnable` — no hay un paso especial que "resuelva un agente por id"; un `Agent` se
pone directo en `do[]`, con su propio `id` como key de `ctx.steps`.

## Cómo se ejecuta un Pipeline

```ts
interface PipelineExecutionContext {
  event: DomainEvent;
  steps: Record<string, unknown>;   // outputs de pasos anteriores, por su `id`
  bus: EventBus;
  pipelineId: string;
}
```

Un paso lee `steps.<id>.output` de CUALQUIER paso anterior con nombre — no sólo el
inmediato — y su propio `when` también puede mirar `steps.*` (el patrón "triage nombrado →
siguiente paso condicionado a `steps.triage.exit`", en un solo `do[]`, sin evento intermedio).

## `Agent` — un `Runnable` respaldado por un LLM

`Agent` es la única pieza de este paquete que asume "hay un modelo de por medio". Se
construye a partir de una `AgentDefinitionProps` (id, `provider`, `prompt`, `systemPrompts`,
`tools`, `exits`, `emitOn`, ...) más un `Provider` — resuelto por id contra un
`ProviderRegistry` (el singleton `providerRegistry`, o uno propio para aislar tests). El
`Provider` es el ÚNICO punto que sabe hablar con un backend real (Anthropic, OpenAI, un CLI
en una sesión de terminal); `agent-pipeline` nunca lo implementa — eso es infra, vive fuera
del paquete (ver `examples/providers/`).

```ts
import { Agent, providerRegistry } from '@ia-tools/agent-pipeline';
import { anthropicProvider } from './my-anthropic-provider.js'; // tuyo, no del paquete

providerRegistry.register(anthropicProvider({ id: 'anthropic-api', model: 'claude-sonnet-5' }));

const triage = new Agent({
  id: 'triage',
  provider: 'anthropic-api',
  prompt: 'Título: {{title}}\n\nRespondé "actionable" o "not-actionable".',
  exits: { actionable: 'actionable', 'not-actionable': 'not-actionable' },
});
```

## Ejemplo mínimo

```ts
import { Agent, Condition, Engine, EventBus, FunctionAction, Pipeline,
         StaticPipelineSource, createEvent, providerRegistry } from '@ia-tools/agent-pipeline';

providerRegistry.register(/* tu Provider, ver arriba */);

const pipeline = new Pipeline({
  id: 'github-bug-triage',
  on: ['github.issue.opened'],
  do: [
    new Agent({
      id: 'triage',
      provider: 'anthropic-api',
      prompt: 'Título: {{title}}\n\nRespondé "actionable" o "not-actionable".',
      exits: { actionable: 'actionable', 'not-actionable': 'not-actionable' },
    }),
    new FunctionAction({
      id: 'fix',
      when: Condition.fromRows([{ field: 'steps.triage.exit', op: 'eq', value: 'actionable' }]),
      fn: () => 'PR abierto',
    }),
  ],
});

const bus = new EventBus();
const engine = new Engine({ bus, pipelines: new StaticPipelineSource([pipeline]) });
engine.start();

await bus.publish(createEvent('github.issue.opened', { title: 'crash on login (bug)' }));
```

## Los tres casos que motivaron esto

Viven en `ia-tools/examples/` (raíz del monorepo, gitignoreado — no en `packages/agent-pipeline/`,
ver la nota de dependencias cíclicas más abajo):

- `apps/github-issue-triage.ts` — un webhook de GitHub se traduce a `github.issue.opened`;
  un pipeline hace triage con un `Agent` real (Anthropic) y despacha un fix determinístico.
- `apps/slack-support-reply.ts` — un evento de Slack (`slack.message`) dispara un pipeline
  que responde sólo si el mensaje matchea un `when` de texto.
- `apps/travel-planner.ts` — un pedido de viaje (`travel.trip.requested`) corre un `Agent`
  con dos tools reales (vuelos, hoteles) y arma una recomendación — el mismo `Engine`, cero
  código nuevo, sólo otro `Pipeline`.
- `tools/` — lógica de negocio mock de las tools del travel-planner.

El `Provider` real de Anthropic es `@ia-tools/provider-anthropic` (paquete propio, no vive acá —
ver su README). `AgentDefinitionProps`/`Agent`/`Provider`/`ProviderRegistry` SÍ están en `src/`
de ESTE paquete — son contrato puro, sin I/O (ver la sección de `Agent` más arriba).

Correlos desde la raíz de `ia-tools` con `npx tsx examples/apps/<archivo>.ts` (necesitan
`ANTHROPIC_API_KEY`, y que `agent-pipeline`/`provider-anthropic` estén buildeados).

### Por qué los examples no viven adentro de este paquete

`@ia-tools/provider-anthropic` depende de `agent-pipeline` (implementa su `Provider`). Si un
example que usa AMBOS paquetes viviera dentro de `agent-pipeline/examples/`, este paquete
necesitaría a su vez depender de `provider-anthropic` (aunque sea sólo en `devDependencies`) —
eso es una dependencia cíclica entre workspaces de pnpm, que rompe el orden de `pnpm -r build`.
Por eso esos tres examples viven en un tercer lugar (`ia-tools/examples/`, gitignoreado) que
depende de los dos sin que ninguno dependa del otro.
