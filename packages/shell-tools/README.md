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

**`argv[0]` se normaliza a minúsculas antes de evaluar la policy.** `PATH` resuelve el nombre del
binario SIN distinguir mayúsculas en macOS/Windows (filesystem case-insensitive por default) —
`Bash`/`PYTHON3`/`Curl` encuentran exactamente los mismos binarios que `bash`/`python3`/`curl`.
Sin normalizar, cambiar la capitalización del comando esquivaba toda la policy (patrones y
chequeos dedicados) en esos sistemas operativos.

**El proceso hijo NO hereda el entorno completo.** Por default corre con un subset mínimo
(`PATH`, `HOME`, `LANG`, `LC_ALL`, `TERM`, `TZ`, `USER`, `SHELL`), nunca `process.env` entero —
heredarlo entero (el default de `child_process.spawn`) le pasaría al comando cualquier secreto
que el host tenga seteado (`GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, credenciales de Slack), y con un
solo intérprete que se cuele por el deny-list alcanza para leerlos. Si un comando necesita algo
puntual del entorno, pasalo explícito con `env: { ... }` en las options.

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
forzado (`--force`/`-f`) a cualquier branch, credenciales del entorno (`env`,
`printenv`), intérpretes de propósito general
(`python`/`python3`/`node`/`ruby`/`perl`/`bun`/`bunx`/`deno`/`tsx`/`php`/`lua`/`awk`/`sed` — con
uno solo permitido el resto de la lista es decorativa), subcomandos de package manager que
corren algo externo al repo (`npx`, `pnpm dlx`/`exec`, `npm exec`, `yarn dlx` — el resto de
`npm`/`pnpm`/`yarn`, como `install`/`test`/`run <script>`, sigue permitido), `xargs` entero,
wrappers que ejecutan otro binario pasado como argumento (`nice`, `timeout`, `nohup`, `stdbuf`,
`time`, `watch`, `setsid` — cualquiera de estos reabre acceso a todo lo de arriba, porque el
deny-list sólo mira `argv[0]` y acá `argv[0]` es el wrapper, no lo que ejecuta), `find` y `tar`
enteros, y `curl`/`wget`/`ssh`/`scp`/`nc` como canales de exfiltración obvios. **No es
exhaustivo** — el deny-list real de producción tiene 200+ líneas con variantes posicionales para
cubrir 2-3 flags delante de cada comando (ver el comentario en `BashPolicy.ts`). Un caller que
necesite esa cobertura arma su propio `BashPolicy`.

### Chequeos dedicados, no posicionales, siempre activos

Estas cosas no se pueden cubrir con patrones de posición fija sin generar una lista enorme y
frágil, así que tienen su propio chequeo en código — corren SIEMPRE, no dependen de lo que el
caller ponga en `deny`, mismo criterio que la validación de `argv[0]` calificado por path:

- **`git push` contra `main`/`master`** — `main`/`master` (o `refs/heads/main`) en cualquier
  posición después de `push` (no sólo la 3ra: `git push -u origin main` también cae),
  `+main`/`:main` (force/delete vía sintaxis de refspec, sin pasar por `--force`),
  `--delete`/`-d`/`--all`/`--mirror`, y `HEAD:refs/heads/main`.
- **`git --upload-pack`/`--exec`** (en `clone`/`fetch`/`push`) — le dicen a git que invoque
  `<cmd>` como su propio helper de transporte, en cualquier posición entre los demás flags.
- **`git -c`/`config`/`--config-env`** — reconfiguran git por invocación o de forma persistente
  (un alias, `core.sshCommand`, `core.pager`, `core.hooksPath`, `credential.helper` corren lo
  que sea vía `sh`). Un patrón posicional (`'git -c *'`, `'git config *'`) sólo mira `argv[1]`,
  así que CUALQUIER opción global antes (`git -C . -c ...`, `git --git-dir=x config ...`) lo
  esquivaba — por eso es chequeo dedicado, no patrón.
- **`cp`/`mv`/`ln`/`chmod`/`chown`/`install`/`rsync` apuntando a un segmento `.git`** —
  `fs-tools` protege `.git` en `resolveSafePath`, pero `bash_run` es un camino totalmente aparte
  al filesystem: `cp payload .git/hooks/pre-commit` + `chmod +x` deja código que corre en el
  próximo `git commit`/`merge`/`checkout`, sin pasar por `fs-tools` en ningún momento. Case-
  insensitive, mismo criterio que el chequeo de `.git` en `fs-tools`.

`find` y `tar` NO tienen chequeo dedicado — se deniegan ENTEROS en `DEFAULT_DENY_PATTERNS` en
vez de perseguir sus flags de ejecución (`-exec`/`-delete`, `--to-command`/`-I`) con un chequeo a
medida: esos flags admiten abreviación (GNU) y forma pegada (`-Ish`), así que ni siquiera un
chequeo dedicado los cubre con certeza — denegar el comando entero es lo único que cierra la
categoría completa.

## Límites honestos de este matcher

- Los patrones de texto (`DEFAULT_DENY_PATTERNS`) SÍ son posicionales — `git push --force* *`
  puede colarse con flags reordenados de una forma que ningún patrón cubre. `main`/`master` y
  los transportes de git ya NO dependen de eso (chequeos dedicados, ver arriba); lo que queda
  expuesto a reordenamiento posicional es sobre todo el force-push a branches DISTINTAS de
  main/master, y cualquier patrón nuevo que agregues vos mismo a `deny`.
- Cualquier comando que acepte una SUBEXPRESIÓN de shell dentro de un único token (`git -c
  alias.x=...`, y en general cualquier `--algo=<comando>` de una herramienta que después invoque
  ese valor) es un vector que el matcher no puede ver por diseño — el patrón compara contra el
  token completo, nunca interpreta lo que hay adentro. `git -c`/`--config-env`/`git config`,
  `--upload-pack`/`--exec` de git, y `find`/`tar` enteros están denegados por esto mismo; una
  herramienta nueva con el mismo problema (invoca un programa externo a partir de un flag)
  necesita su propia entrada.
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
