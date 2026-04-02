---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.vue"
---

# TypeScript & Vue Standards

## Tooling

- Formatter: `prettier`
- Linter: `eslint` with `@nuxt/eslint-config` (for Nuxt projects)
- Package manager: `pnpm`
- Test runner: `vitest`
- Build: `nuxi build` (Nuxt) or `tsup` (libraries)

## TypeScript

- Strict mode always (`"strict": true` in tsconfig)
- Never use `any` — use `unknown` and narrow with type guards
- Prefer `interface` for object shapes, `type` for unions/intersections
- Use `satisfies` operator for type-safe object literals
- Prefer `const` over `let`. Never use `var`
- Use optional chaining (`?.`) and nullish coalescing (`??`)

## Vue / Nuxt

- Composition API only — no Options API
- Use `<script setup lang="ts">` in Single File Components
- Use `defineProps` with TypeScript generics (not runtime declaration)
- Use Pinia for state management with `defineStore` + setup syntax
- Use composables (`use*` prefix) for shared logic
- Components: PascalCase filenames, one component per file
- Use `useAsyncData` or `useFetch` for data fetching (not raw fetch)

## Patterns

- Use `$fetch` (Nuxt) or `ofetch` for HTTP requests
- Use `zod` for runtime validation of external data
- Use template refs with `useTemplateRef` (not string refs)
- Prefer named exports over default exports
- Prefer `for...of` over `.forEach()`

## Testing

- Use `vitest` with `@vue/test-utils` for component tests
- Use `describe` / `it` structure
- Mock server routes with `msw` or `vi.mock`
- Test behavior, not implementation details
