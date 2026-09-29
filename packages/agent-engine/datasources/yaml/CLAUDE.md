# @ia-tools/agent-engine-datasource-yaml

Un datasource de `@ia-tools/agent-engine`: traduce una carpeta de YAML a definiciones
(`SourceDocs` de `@ia-tools/agent-engine-definitions`). Nada más: no arma entidades, no compone el
engine, no sabe de proyectos. Cambiarlo por otro datasource (SQLite, Postgres) es cambiar quién
produce las definiciones.

```
<dir>/
  source.yaml         id, vars, systemPrompts, onError, report   (opcional)
  agents/*.yaml       un agente por archivo
  pipelines/*.yaml    una pipeline por archivo, en orden de nombre
```

- **`YamlDefinitionSource`** — `read()` lee y valida cada archivo contra el schema de las
  definiciones (errores con archivo y campo); `version()` es la firma de sus archivos (fecha,
  tamaño, uno nuevo o borrado). Su id: la opción `id`, si no el de `source.yaml`, y si no el nombre
  de la carpeta. `fromRoot(root)`: una fuente por subcarpeta.
- **`vars`** (las de `source.yaml` sobre la opción `vars`): `{{vars.x}}` se sustituye en el YAML
  crudo ANTES de validar, así el schema ve el valor real; una var que no existe rompe la lectura.
- Para servirla al engine: `new DefinitionPipelineSource(new YamlDefinitionSource({ dir }), catalogs)`.

## Antes de commitear

```bash
pnpm --filter @ia-tools/agent-engine-datasource-yaml typecheck
pnpm --filter @ia-tools/agent-engine-datasource-yaml test
pnpm --filter @ia-tools/agent-engine-datasource-yaml build
```
