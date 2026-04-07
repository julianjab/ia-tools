"""Generador de scaffolding de tests para módulos Python.

Analiza un módulo Python y genera un esqueleto de test con:
- Imports necesarios
- Fixtures basadas en los tipos de los parámetros
- Test stubs para cada función/método público
- Estructura AAA (Arrange, Act, Assert)
"""

from __future__ import annotations

import ast
from dataclasses import dataclass, field
from pathlib import Path
from textwrap import dedent


@dataclass(frozen=True)
class FunctionInfo:
    """Información extraída de una función para generar tests."""

    name: str
    is_async: bool
    is_method: bool
    class_name: str | None
    args: list[str]
    return_annotation: str | None
    has_docstring: bool
    lineno: int


@dataclass
class TestScaffold:
    """Scaffolding generado para un módulo."""

    module_path: str
    module_name: str
    functions: list[FunctionInfo] = field(default_factory=list)

    def generate(self) -> str:
        """Genera el código del test file."""
        lines: list[str] = []

        # Header
        lines.append(f'"""Tests for {self.module_name}."""')
        lines.append("")
        lines.append("from __future__ import annotations")
        lines.append("")

        # Imports
        has_async = any(f.is_async for f in self.functions)
        lines.append("import pytest")
        if has_async:
            lines.append("import pytest_asyncio")
        lines.append("")
        lines.append(f"from {self._module_import_path()} import (")
        for func in self.functions:
            if not func.is_method:
                lines.append(f"    {func.name},")
        # Add class imports
        classes = {f.class_name for f in self.functions if f.class_name}
        for cls in sorted(classes):
            lines.append(f"    {cls},")
        lines.append(")")
        lines.append("")
        lines.append("")

        # Generate test functions
        for func in self.functions:
            lines.extend(self._generate_test_function(func))
            lines.append("")

        return "\n".join(lines)

    def _module_import_path(self) -> str:
        """Convierte path a import path."""
        path = Path(self.module_path)
        parts = list(path.with_suffix("").parts)
        # Remove common prefixes
        for prefix in ("src", "lib"):
            if parts and parts[0] == prefix:
                parts.pop(0)
        return ".".join(parts)

    def _generate_test_function(self, func: FunctionInfo) -> list[str]:
        """Genera un test stub para una función."""
        lines: list[str] = []
        prefix = f"test_{func.class_name.lower()}_" if func.class_name else "test_"
        test_name = f"{prefix}{func.name}_happy_path"

        if func.is_async:
            lines.append(f"async def {test_name}() -> None:")
        else:
            lines.append(f"def {test_name}() -> None:")

        lines.append(f'    """{func.name} should return expected result."""')
        lines.append("    # Arrange")

        if func.class_name:
            lines.append(f"    instance = {func.class_name}()")

        for arg in func.args:
            lines.append(f"    {arg} = ...  # TODO: provide test value")

        lines.append("")
        lines.append("    # Act")

        args_str = ", ".join(func.args)
        if func.class_name:
            call = f"instance.{func.name}({args_str})"
        else:
            call = f"{func.name}({args_str})"

        if func.is_async:
            lines.append(f"    result = await {call}")
        else:
            lines.append(f"    result = {call}")

        lines.append("")
        lines.append("    # Assert")
        lines.append("    assert result is not None  # TODO: add specific assertions")
        lines.append("")

        # Generate error case stub
        error_test_name = f"{prefix}{func.name}_error_case"
        if func.is_async:
            lines.append(f"async def {error_test_name}() -> None:")
        else:
            lines.append(f"def {error_test_name}() -> None:")
        lines.append(f'    """{func.name} should handle error gracefully."""')
        lines.append("    # TODO: implement error case test")
        lines.append('    pytest.skip("Not implemented yet")')
        lines.append("")

        return lines


class ModuleParser(ast.NodeVisitor):
    """Parsea un módulo Python y extrae información de funciones."""

    def __init__(self) -> None:
        self._functions: list[FunctionInfo] = []
        self._current_class: str | None = None

    def parse_file(self, path: str | Path) -> list[FunctionInfo]:
        """Parsea un archivo y retorna info de funciones públicas."""
        path = Path(path)
        source = path.read_text(encoding="utf-8")
        return self.parse_source(source)

    def parse_source(self, source: str) -> list[FunctionInfo]:
        """Parsea código fuente y retorna info de funciones públicas."""
        self._functions = []
        self._current_class = None
        tree = ast.parse(source)
        self.visit(tree)
        return list(self._functions)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:  # noqa: N802
        if not node.name.startswith("_"):
            self._current_class = node.name
            self.generic_visit(node)
            self._current_class = None

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:  # noqa: N802
        self._process_function(node, is_async=False)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:  # noqa: N802
        self._process_function(node, is_async=True)

    def _process_function(
        self, node: ast.FunctionDef | ast.AsyncFunctionDef, *, is_async: bool
    ) -> None:
        # Skip private functions
        if node.name.startswith("_") and node.name != "__init__":
            return

        args = [
            arg.arg
            for arg in node.args.args
            if arg.arg not in ("self", "cls")
        ]

        return_annotation = None
        if node.returns:
            return_annotation = ast.unparse(node.returns)

        has_docstring = (
            bool(node.body)
            and isinstance(node.body[0], ast.Expr)
            and isinstance(node.body[0].value, ast.Constant)
            and isinstance(node.body[0].value.value, str)
        )

        self._functions.append(
            FunctionInfo(
                name=node.name,
                is_async=is_async,
                is_method=self._current_class is not None,
                class_name=self._current_class,
                args=args,
                return_annotation=return_annotation,
                has_docstring=has_docstring,
                lineno=node.lineno,
            )
        )
