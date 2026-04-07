# Python Development Agents

Este plugin proporciona agentes especializados para desarrollo en Python. Usa estos agentes cuando trabajes con código Python y necesites:

- **Code Review**: Revisión profunda de código, detección de bugs, mejoras de rendimiento y adherencia a mejores prácticas.
- **Testing**: Generación y ejecución de tests unitarios e integración con pytest.
- **Refactoring**: Refactorización de código siguiendo principios SOLID, DRY y patrones de diseño Python.
- **Documentation**: Generación de docstrings (Google style), type hints y documentación técnica.

## Cuándo usar cada agente

| Necesidad | Agente |
|-----------|--------|
| "Revisa este código" / "¿Hay bugs?" | `python-dev-agents:code-review` |
| "Genera tests" / "Necesito cobertura" | `python-dev-agents:testing` |
| "Refactoriza esto" / "Simplifica" | `python-dev-agents:refactoring` |
| "Documenta" / "Agrega docstrings" | `python-dev-agents:documentation` |

## Convenciones aplicadas

- Python 3.12+
- Type hints obligatorios
- Docstrings estilo Google
- Formatting con ruff
- Testing con pytest
