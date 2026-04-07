"""Analizador de complejidad ciclomática y cognitiva para código Python.

Usa el módulo ast de Python para calcular métricas de complejidad
sin dependencias externas pesadas.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class ComplexityResult:
    """Resultado de análisis de complejidad para una función o método."""

    name: str
    lineno: int
    col_offset: int
    cyclomatic: int
    cognitive: int
    loc: int  # lines of code

    @property
    def risk(self) -> str:
        """Clasifica el riesgo basado en complejidad ciclomática."""
        if self.cyclomatic <= 5:
            return "low"
        if self.cyclomatic <= 10:
            return "moderate"
        if self.cyclomatic <= 20:
            return "high"
        return "very_high"


@dataclass
class FileComplexityReport:
    """Reporte de complejidad para un archivo completo."""

    path: str
    functions: list[ComplexityResult] = field(default_factory=list)

    @property
    def max_cyclomatic(self) -> int:
        return max((f.cyclomatic for f in self.functions), default=0)

    @property
    def avg_cyclomatic(self) -> float:
        if not self.functions:
            return 0.0
        return sum(f.cyclomatic for f in self.functions) / len(self.functions)

    @property
    def high_risk_functions(self) -> list[ComplexityResult]:
        return [f for f in self.functions if f.risk in ("high", "very_high")]


class ComplexityAnalyzer(ast.NodeVisitor):
    """Calcula complejidad ciclomática y cognitiva usando AST."""

    # Nodos que incrementan complejidad ciclomática
    BRANCHING_NODES = (
        ast.If,
        ast.For,
        ast.While,
        ast.ExceptHandler,
        ast.With,
        ast.Assert,
        ast.comprehension,
    )

    def __init__(self) -> None:
        self._results: list[ComplexityResult] = []

    def analyze_file(self, path: str | Path) -> FileComplexityReport:
        """Analiza un archivo Python y retorna reporte de complejidad."""
        path = Path(path)
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(path))
        self._results = []
        self.visit(tree)
        return FileComplexityReport(path=str(path), functions=list(self._results))

    def analyze_source(self, source: str, filename: str = "<string>") -> FileComplexityReport:
        """Analiza código fuente como string."""
        tree = ast.parse(source, filename=filename)
        self._results = []
        self.visit(tree)
        return FileComplexityReport(path=filename, functions=list(self._results))

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:  # noqa: N802
        self._analyze_function(node)
        self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:  # noqa: N802
        self._analyze_function(node)
        self.generic_visit(node)

    def _analyze_function(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        cyclomatic = self._calculate_cyclomatic(node)
        cognitive = self._calculate_cognitive(node)
        loc = (node.end_lineno or node.lineno) - node.lineno + 1

        self._results.append(
            ComplexityResult(
                name=node.name,
                lineno=node.lineno,
                col_offset=node.col_offset,
                cyclomatic=cyclomatic,
                cognitive=cognitive,
                loc=loc,
            )
        )

    def _calculate_cyclomatic(self, node: ast.AST) -> int:
        """Complejidad ciclomática = 1 + número de puntos de decisión."""
        complexity = 1
        for child in ast.walk(node):
            if isinstance(child, self.BRANCHING_NODES):
                complexity += 1
            elif isinstance(child, ast.BoolOp):
                # cada operador and/or agrega un camino
                complexity += len(child.values) - 1
        return complexity

    def _calculate_cognitive(self, node: ast.AST, nesting: int = 0) -> int:
        """Complejidad cognitiva: penaliza anidamiento profundo."""
        total = 0
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.If, ast.For, ast.While)):
                # incremento base + penalización por nesting
                total += 1 + nesting
                total += self._calculate_cognitive(child, nesting + 1)
            elif isinstance(child, (ast.ExceptHandler,)):
                total += 1 + nesting
                total += self._calculate_cognitive(child, nesting + 1)
            elif isinstance(child, ast.BoolOp):
                total += 1
                total += self._calculate_cognitive(child, nesting)
            else:
                total += self._calculate_cognitive(child, nesting)
        return total
