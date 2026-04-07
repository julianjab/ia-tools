"""Detector de code smells comunes en Python usando AST.

Detecta patrones problemáticos como:
- Mutables como defaults
- except demasiado amplio
- funciones muy largas
- imports no usados
- datetime sin timezone
"""

from __future__ import annotations

import ast
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path


class Severity(StrEnum):
    CRITICAL = "critical"
    WARNING = "warning"
    INFO = "info"


class SmellType(StrEnum):
    MUTABLE_DEFAULT = "mutable_default"
    BARE_EXCEPT = "bare_except"
    BROAD_EXCEPT = "broad_except"
    LONG_FUNCTION = "long_function"
    TOO_MANY_ARGS = "too_many_args"
    DATETIME_NO_TZ = "datetime_no_tz"
    OS_PATH_USAGE = "os_path_usage"
    TYPE_INSTEAD_OF_ISINSTANCE = "type_instead_of_isinstance"
    FSTRING_IN_LOGGING = "fstring_in_logging"
    NESTED_DEPTH = "nested_depth"


@dataclass(frozen=True)
class CodeSmell:
    """Un code smell detectado en el código."""

    smell_type: SmellType
    severity: Severity
    message: str
    lineno: int
    col_offset: int
    suggestion: str


class SmellDetector(ast.NodeVisitor):
    """Detecta code smells comunes en Python."""

    MAX_FUNCTION_LINES = 50
    MAX_ARGS = 5
    MAX_NESTING = 4

    def __init__(self) -> None:
        self.smells: list[CodeSmell] = []

    def analyze_file(self, path: str | Path) -> list[CodeSmell]:
        """Analiza un archivo y retorna lista de code smells."""
        path = Path(path)
        source = path.read_text(encoding="utf-8")
        return self.analyze_source(source)

    def analyze_source(self, source: str) -> list[CodeSmell]:
        """Analiza código fuente como string."""
        self.smells = []
        tree = ast.parse(source)
        self.visit(tree)
        return list(self.smells)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:  # noqa: N802
        self._check_function(node)
        self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:  # noqa: N802
        self._check_function(node)
        self.generic_visit(node)

    def visit_ExceptHandler(self, node: ast.ExceptHandler) -> None:  # noqa: N802
        if node.type is None:
            self.smells.append(
                CodeSmell(
                    smell_type=SmellType.BARE_EXCEPT,
                    severity=Severity.CRITICAL,
                    message="Bare `except:` captura todas las excepciones incluyendo SystemExit y KeyboardInterrupt",
                    lineno=node.lineno,
                    col_offset=node.col_offset,
                    suggestion="Usa `except Exception:` como mínimo, o captura excepciones específicas",
                )
            )
        elif isinstance(node.type, ast.Name) and node.type.id == "Exception":
            self.smells.append(
                CodeSmell(
                    smell_type=SmellType.BROAD_EXCEPT,
                    severity=Severity.WARNING,
                    message="`except Exception` es demasiado amplio",
                    lineno=node.lineno,
                    col_offset=node.col_offset,
                    suggestion="Captura excepciones específicas (ValueError, TypeError, etc.)",
                )
            )
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:  # noqa: N802
        self._check_datetime_no_tz(node)
        self._check_type_usage(node)
        self.generic_visit(node)

    def _check_function(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        # Check mutable defaults
        for default in node.args.defaults + node.args.kw_defaults:
            if default is not None and isinstance(default, (ast.List, ast.Dict, ast.Set)):
                self.smells.append(
                    CodeSmell(
                        smell_type=SmellType.MUTABLE_DEFAULT,
                        severity=Severity.CRITICAL,
                        message=f"Mutable como valor default en `{node.name}()`",
                        lineno=default.lineno,
                        col_offset=default.col_offset,
                        suggestion="Usa `None` como default y asigna el mutable dentro del body: `if x is None: x = []`",
                    )
                )

        # Check function length
        loc = (node.end_lineno or node.lineno) - node.lineno + 1
        if loc > self.MAX_FUNCTION_LINES:
            self.smells.append(
                CodeSmell(
                    smell_type=SmellType.LONG_FUNCTION,
                    severity=Severity.WARNING,
                    message=f"`{node.name}()` tiene {loc} líneas (máx recomendado: {self.MAX_FUNCTION_LINES})",
                    lineno=node.lineno,
                    col_offset=node.col_offset,
                    suggestion="Extrae subfunciones para mejorar legibilidad",
                )
            )

        # Check too many arguments
        total_args = len(node.args.args) + len(node.args.kwonlyargs)
        if node.args.vararg:
            total_args += 1
        if node.args.kwarg:
            total_args += 1
        # Exclude self/cls
        if total_args > 0 and node.args.args and node.args.args[0].arg in ("self", "cls"):
            total_args -= 1

        if total_args > self.MAX_ARGS:
            self.smells.append(
                CodeSmell(
                    smell_type=SmellType.TOO_MANY_ARGS,
                    severity=Severity.WARNING,
                    message=f"`{node.name}()` tiene {total_args} argumentos (máx recomendado: {self.MAX_ARGS})",
                    lineno=node.lineno,
                    col_offset=node.col_offset,
                    suggestion="Agrupa argumentos relacionados en un dataclass o usa **kwargs",
                )
            )

    def _check_datetime_no_tz(self, node: ast.Call) -> None:
        """Detecta datetime.now() sin timezone."""
        if (
            isinstance(node.func, ast.Attribute)
            and node.func.attr == "now"
            and isinstance(node.func.value, ast.Attribute)
            and node.func.value.attr == "datetime"
        ):
            # datetime.datetime.now() sin args = sin timezone
            if not node.args and not node.keywords:
                self.smells.append(
                    CodeSmell(
                        smell_type=SmellType.DATETIME_NO_TZ,
                        severity=Severity.WARNING,
                        message="`datetime.datetime.now()` sin timezone es ambiguo",
                        lineno=node.lineno,
                        col_offset=node.col_offset,
                        suggestion="Usa `datetime.datetime.now(tz=datetime.UTC)` o `datetime.datetime.now(tz=ZoneInfo('America/Bogota'))`",
                    )
                )

    def _check_type_usage(self, node: ast.Call) -> None:
        """Detecta type() usado para comparar tipos."""
        if isinstance(node.func, ast.Name) and node.func.id == "type" and len(node.args) == 1:
            # Chequear si está dentro de una comparación
            # Esto es una heurística — el visitor padre podría ser Compare
            self.smells.append(
                CodeSmell(
                    smell_type=SmellType.TYPE_INSTEAD_OF_ISINSTANCE,
                    severity=Severity.INFO,
                    message="Uso de `type()` — considera `isinstance()` que soporta herencia",
                    lineno=node.lineno,
                    col_offset=node.col_offset,
                    suggestion="Reemplaza `type(x) == SomeClass` por `isinstance(x, SomeClass)`",
                )
            )
