# @ia-tools/agent-pipeline

Harness domain-agnostic para componer agentes en pipelines que reaccionan a eventos.
No sabe nada de GitHub, Slack ni viajes — sólo conoce `DomainEvent`, `Agent`, `Pipeline`
y `Engine`. Cada app que lo use trae su propio conector de entrada (webhook, Socket Mode,
un cron) que traduce su mundo a `DomainEvent` y sus propios `Agent`s.

Nace de auditar `ia-flow-worktrees/v2-platform/packages/engine-v2` (el motor de pipelines
de ia-flow): el patrón central — `EventBus` → `Pipeline` (matchea por `on`/`when`) → cadena
de `do[]` donde cada paso ve `ctx.steps` de TODOS los pasos anteriores, no sólo el
inmediato — es exactamente lo que hace falta acá. Lo que se dejó afuera a propósito:

- **`Task`/`Project`/`Repo`** — modelan un issue de GitHub con status/PRD/comments/PRs.
  Acá `event.scope` es `Record<string, unknown>` libre: cada dominio pone las claves que
  necesita (`{ owner, repo, issueNumber }`, `{ workspace, channel }`, `{ tripId }`).
- **`Execution`/pausa-y-reanudación de un run largo** — complejidad real (`run_checkpoints`,
  reanudar la conversación exacta de un provider) que no vale la pena portar hasta que un
  caso de uso concreto la necesite. Un `Agent.run` acá es una llamada de punta a punta.
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
Agent         { id, run(input) → { output, exit? } }         — la unidad componible
Condition     { field, op, value, logic }                    — un `when` puro sobre un payload
Pipeline      { on, when?, scope?, exclusive?, do: Action[] } — matchea eventos, corre su cadena
Engine        dispatch(event) contra el roster de Pipeline    — el orquestador
EventBus      publish/subscribe in-process                    — pega todo
```

Acciones de un `do[]`: `AgentAction` (corre un `Agent`), `EmitAction` (publica un evento
derivado), `HttpAction` (llama una API), `FunctionAction` (corre código TS con el contexto
completo).

## Cómo se ejecuta un Pipeline

```ts
interface PipelineExecutionContext {
  event: DomainEvent;
  steps: Record<string, unknown>;   // outputs de pasos anteriores, por su `id`
  agents: AgentSource;
  bus: EventBus;
  pipelineId: string;
}
```

Un paso lee `steps.<id>.output` de CUALQUIER paso anterior con nombre — no sólo el
inmediato — y su propio `when` también puede mirar `steps.*` (el patrón "triage nombrado →
siguiente paso condicionado a `steps.triage.output.actionable`", en un solo `do[]`, sin
evento intermedio).

## Ejemplo mínimo

```ts
import { AgentAction, AgentRegistry, Engine, EventBus, Pipeline, StaticPipelineSource,
         createEvent, functionAgent } from '@ia-tools/agent-pipeline';

const agents = new AgentRegistry()
  .register(functionAgent('triage', (input) => ({
    actionable: (input.event.payload as any).title.includes('bug'),
  })))
  .register(functionAgent('fix', async () => 'PR abierto'));

const pipeline = new Pipeline({
  id: 'github-bug-triage',
  on: ['github.issue.opened'],
  do: [
    new AgentAction({ id: 'triage', agentId: 'triage' }),
    new AgentAction({
      id: 'fix',
      agentId: 'fix',
      when: Condition.fromRows([{ field: 'steps.triage.output.actionable', op: 'eq', value: true }]),
    }),
  ],
});

const bus = new EventBus();
const engine = new Engine({ bus, agents, pipelines: new StaticPipelineSource([pipeline]) });
engine.start();

await bus.publish(createEvent('github.issue.opened', { title: 'crash on login (bug)' }));
```

## Los tres casos que motivaron esto

Ver `examples/`:

- `github-issues.ts` — un webhook de GitHub se traduce a `github.issue.opened`; un pipeline
  hace triage con un agente y despacha un fix con otro.
- `slack-messages.ts` — un evento de Slack (`slack.message`) dispara un pipeline que
  responde sólo si el mensaje matchea un `when` de texto.
- `travel-planner.ts` — un pedido de viaje (`travel.trip.requested`) encadena dos agentes
  independientes (vuelos, hoteles) y un tercero que combina sus outputs — el mismo `Engine`,
  cero código nuevo, sólo otro `Pipeline` y otros `Agent`s.

Correlos con `npx tsx examples/<archivo>.ts` (o compilá primero con `pnpm build` y corré el
`.js` de `dist`).

## Conectar un agente real

Este paquete es sólo dominio: `Agent` es la interfaz `{ id, run(input) }`, sin ninguna
implementación atada a un proveedor concreto. A propósito — un adapter contra la API de
Anthropic, un cliente HTTP a un datasource, una credencial, son infraestructura de QUIEN
consume la lib, no del harness. Cada app trae su propio `Agent` (usando `functionAgent` como
wrapper mínimo, o una clase propia) que adentro llama a lo que quiera: `@anthropic-ai/sdk`,
otra API de vuelos, un fetch a Slack. El contrato que importa es el que expone `Agent.run`
— `Pipeline`/`Engine` nunca saben ni les importa qué hay del otro lado.
