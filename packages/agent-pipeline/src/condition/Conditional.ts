import { Condition } from './Condition.js';

export interface ConditionalProps {
  when?: Condition[];
}

/**
 * Base para cualquier entidad que matchea contra un `when` — antes de esto, `Pipeline` y
 * `PipelineAction` reimplementaban CADA UNA el mismo loop de encadenado and/or
 * (`Condition.evaluateAll` ya lo hacía; `PipelineAction.evaluateWhen` lo copiaba a mano).
 * Ahora las dos delegan en `matchesConditions`, así que el algoritmo vive en un solo lugar —
 * `Condition.evaluateAll` — y esta clase sólo lo expone. Lo que SÍ varía por subclase es qué
 * arman como `subject`: `Pipeline` evalúa contra el payload crudo del evento;
 * `PipelineAction` le agrega `steps` antes de evaluar (ver su propio `shouldRun`).
 */
export abstract class Conditional {
  readonly when: Condition[];

  constructor(props: ConditionalProps) {
    this.when = props.when ?? [];
  }

  matchesConditions(subject: unknown): boolean {
    return Condition.evaluateAll(this.when, subject);
  }
}
