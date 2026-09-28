import { Condition } from '../../condition/Condition.js';
import { createEvent } from '../../events/DomainEvent.js';
import { Pipeline } from '../../pipeline/Pipeline.js';
import { FunctionAction } from '../../pipeline/actions/FunctionAction.js';
import { executionStoreContract, pipelineSourceContract } from '../../testing/index.js';
import { InMemoryExecutionStore } from '../ExecutionStore.js';
import { StaticPipelineSource } from '../PipelineSource.js';
import { Project } from '../Project.js';

const noop = () => new FunctionAction({ fn: () => undefined });

executionStoreContract('InMemoryExecutionStore', (options) => new InMemoryExecutionStore(options));

pipelineSourceContract('StaticPipelineSource', () => ({
  source: new StaticPipelineSource([
    new Pipeline({ id: 'a', on: ['build'], do: [noop()] }),
    new Pipeline({ id: 'b', on: ['build'], position: 1, do: [noop()] }),
    new Pipeline({ id: 'c', on: ['other'], do: [noop()] }),
  ]),
  matching: createEvent('build', {}),
  expected: ['a', 'b'],
  nonMatching: createEvent('nobody', {}),
}));

pipelineSourceContract('Project', () => ({
  source: new Project({
    id: 'p',
    when: [new Condition({ field: 'labels', op: 'notContains', value: 'blocked' })],
    pipelines: [new Pipeline({ id: 'build', on: ['build'], do: [noop()] })],
  }),
  matching: createEvent('build', { labels: [] }),
  expected: ['build'],
  nonMatching: createEvent('build', { labels: ['blocked'] }),
}));
