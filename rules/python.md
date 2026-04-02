---
paths:
  - "**/*.py"
---

# Python Standards

## Tooling

- Formatter: `ruff format` (line-length: 100)
- Linter: `ruff check`
- Type checker: `pyright` (strict mode)
- Package manager: `uv`
- Test runner: `pytest`

## Style

- `from __future__ import annotations` in every file
- Type hints on all function signatures (params + return)
- Use `pydantic.BaseModel` for data that crosses boundaries (API, DB, config)
- Use `dataclass` for internal-only data structures
- Use `Protocol` for interfaces (not ABC unless state is needed)
- Async by default for all I/O operations

## Patterns

- Use `httpx` for HTTP clients (not requests)
- Use `structlog` for logging (not logging.getLogger)
- Use `pathlib.Path` for file operations (not os.path)
- Prefer list/dict/set comprehensions over manual loops when readable
- Use context managers (`with`) for resource management

## Imports

- Group: stdlib → third-party → local (ruff handles this)
- Use absolute imports, not relative (except within a package's own modules)
- Never use `from module import *`

## Testing

- Fixtures in `conftest.py`
- Name tests: `test_{function_name}_{scenario}`
- Use `pytest.mark.parametrize` for data-driven tests
- Mock external dependencies, never mock the code under test
- Use `httpx.AsyncClient` for testing FastAPI endpoints
