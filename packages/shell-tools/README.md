# @ia-tools/shell-tools

`Tool` `bash_run` de [`@ia-tools/agent-pipeline`](../agent-pipeline) — ejecuta un comando SIN
shell (sin pipes, redirecciones ni expansión) contra una policy allow/deny posicional. Réplica
acotada del `bash_run` de `ai-development-flow` (ver `examples/apps/ai-development-flow-runner.ts`
y `20-implementer.yaml` en ese repo).

## Instalar (dentro del monorepo)

```bash
pnpm --filter @ia-tools/shell-tools build
pnpm --filter @ia-tools/shell-tools test
```

## Uso

```ts
import { Agent } from '@ia-tools/agent-pipeline';
import { BashRunTool, DEFAULT_DENY_PATTERNS } from '@ia-tools/shell-tools';

const bashRun = new BashRunTool({
  baseDir: '/path/al/worktree',
  policy: { deny: DEFAULT_DENY_PATTERNS }, // allow default: ['*'] — todo salvo lo denegado
});

const implementer = new Agent({
  id: 'implementer',
  provider: 'anthropic-api',
  prompt: '...',
  tools: [bashRun],
  exits: { done: 'done' },
});
```

El modelo manda un `command` como string (`"git status"`, `"npm test"`) — se tokeniza SIN pasar
por un shell (no hay `sh -c` de por medio), así que pipes/redirecciones/`$VAR` no existen acá; si
el modelo los usa, `bash_run` tira en vez de ejecutar algo distinto de lo que pidió.

**El comando (`argv[0]`) nunca puede incluir un path** — `/bin/rm`, `./evil.sh`, `bin/curl` tiran,
siempre, sin excepción de policy. Sólo se ejecutan nombres de binario resueltos por `PATH`. Sin
esto, cualquier regla de `deny` que compare contra el nombre pelado (`'rm *'`, `'curl *'`) se
saltaría con sólo anteponer la ruta absoluta del binario.

## La policy — `allow`/`deny`, `deny` siempre gana

```ts
interface BashPolicy {
  allow?: string[]; // default ['*']
  deny: string[];
}
```

Cada patrón es texto tokenizado por espacio, matcheado POSICIONALMENTE contra el `argv` del
comando — `git push * main` matchea `git push origin main` pero no `git push origin dev`. Un
`*` al final del patrón matchea "el resto, cualquier cantidad, incluso cero" (`bash *` matchea
tanto `bash` solo como `bash -c algo`); un token que termina en `*` (`--force*`) es un prefix
match de ESE token puntual.

`DEFAULT_DENY_PATTERNS` es un subset curado — shells anidados, `rm`, `sudo`/`su`, push
forzado/directo a `main`/`master` (incluyendo `HEAD:main`, flags después del nombre de la
branch, y `git -C <dir> push`), credenciales del entorno (`env`, `printenv`), intérpretes
(`python`/`python3`/`node`/`ruby`/`perl`/`npx`), ejecución indirecta (`xargs`, `find -exec`/
`-delete`), y `curl`/`wget`/`ssh`/`scp`/`nc` como canales de exfiltración obvios. **No es
exhaustivo** — el deny-list real de producción tiene 200+ líneas con variantes posicionales para
cubrir 2-3 flags delante de cada comando (ver el comentario en `BashPolicy.ts`). Un caller que
necesite esa cobertura arma su propio `BashPolicy`.

## Límites honestos de este matcher

- Es POSICIONAL, no un parser de flags: cubre las formas más obvias en las posiciones que mira,
  no todas las variantes de reordenar flags — `git -C . push -u origin main` (flags intercaladas
  en otro orden del que cubre `DEFAULT_DENY_PATTERNS`) puede colarse. Cerrar esto de verdad pide
  normalizar argv (parsear flags) antes de matchear, no está hecho acá.
- Los intérpretes SÍ están en `DEFAULT_DENY_PATTERNS` por default, pero si un caller los habilita
  (los saca de su propio `deny`, o define un `allow` que los incluye) el deny-list pasa a ser
  fricción, no un sandbox: `python -c "import os; os.system(...)"` corre lo que sea. La
  contención real es DÓNDE corre el proceso (una imagen sin credenciales, un usuario de mínimo
  privilegio), no esta lista.
- `resolveSafePath`/`fs-tools` y esta policy son capas independientes: `bash_run` puede crear un
  symlink (`ln -s ~/.ssh k`) que después una tool de `fs-tools` seguiría si no filtrara
  symlinks — cada capa asume que la otra hace su parte, ninguna sustituye a la otra.

## Qué NO es este paquete

No hace nada con el filesystem más allá de `cwd: baseDir` (para eso, `@ia-tools/fs-tools`), no
sabe nada de git/GitHub, y no tiene memoria entre corridas.
