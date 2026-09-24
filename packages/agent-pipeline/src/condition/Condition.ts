export type ConditionOp =
  | 'eq'
  | 'neq'
  | 'exists'
  | 'notExists'
  | 'in'
  | 'notIn'
  | 'contains'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte';

export interface ConditionRow {
  /** Path punteado sobre el payload, ej. "task.status" o "trip.origin". */
  field: string;
  op: ConditionOp;
  value?: unknown;
  /** Cómo se combina con la condición anterior de la misma lista — default 'and'. */
  logic?: 'and' | 'or';
}

/** Un `when` puro sobre un payload — sin I/O, testeable sin levantar nada. */
export class Condition {
  readonly field: string;
  readonly op: ConditionOp;
  readonly value?: unknown;
  readonly logic: 'and' | 'or';

  constructor(row: ConditionRow) {
    this.field = row.field;
    this.op = row.op;
    this.value = row.value;
    this.logic = row.logic ?? 'and';
  }

  evaluate(payload: unknown): boolean {
    const actual = getPath(payload, this.field);
    switch (this.op) {
      case 'eq':
        return actual === this.value;
      case 'neq':
        return actual !== this.value;
      case 'exists':
        return actual !== undefined && actual !== null;
      case 'notExists':
        return actual === undefined || actual === null;
      case 'in':
        return Array.isArray(this.value) && this.value.includes(actual);
      case 'notIn':
        return Array.isArray(this.value) && !this.value.includes(actual);
      case 'contains':
        if (Array.isArray(actual)) return actual.includes(this.value);
        if (typeof actual === 'string' && typeof this.value === 'string') {
          return actual.includes(this.value);
        }
        return false;
      case 'gt':
        return typeof actual === 'number' && typeof this.value === 'number' && actual > this.value;
      case 'gte':
        return typeof actual === 'number' && typeof this.value === 'number' && actual >= this.value;
      case 'lt':
        return typeof actual === 'number' && typeof this.value === 'number' && actual < this.value;
      case 'lte':
        return typeof actual === 'number' && typeof this.value === 'number' && actual <= this.value;
      default:
        return false;
    }
  }

  static fromRows(rows: ConditionRow[] | undefined): Condition[] {
    return (rows ?? []).map((row) => new Condition(row));
  }

  /**
   * Evalúa una lista de conditions con `and`/`or` en cadena (izquierda a derecha, sin
   * precedencia de operadores — el `logic` de cada entrada dice cómo se combina con el
   * resultado acumulado hasta ahí). Lista vacía = matchea siempre.
   */
  static evaluateAll(conditions: Condition[], payload: unknown): boolean {
    if (conditions.length === 0) return true;
    let result = conditions[0].evaluate(payload);
    for (let i = 1; i < conditions.length; i++) {
      const condition = conditions[i];
      const value = condition.evaluate(payload);
      result = condition.logic === 'or' ? result || value : result && value;
    }
    return result;
  }
}

function getPath(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, source);
}
