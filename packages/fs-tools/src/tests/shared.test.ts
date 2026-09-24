import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveSafePath } from '../shared.js';

const baseDir = '/tmp/fs-tools-test-base';

describe('resolveSafePath', () => {
  it('resuelve un path relativo dentro de baseDir', () => {
    expect(resolveSafePath(baseDir, 'src/index.ts')).toBe(join(baseDir, 'src/index.ts'));
  });

  it('resuelve "." a baseDir mismo', () => {
    expect(resolveSafePath(baseDir, '.')).toBe(join(baseDir));
  });

  it('rechaza un path absoluto', () => {
    expect(() => resolveSafePath(baseDir, '/etc/passwd')).toThrow('absoluto');
  });

  it('rechaza un path traversal que se escapa de baseDir', () => {
    expect(() => resolveSafePath(baseDir, '../../etc/passwd')).toThrow('fuera de baseDir');
  });

  it('rechaza un traversal disfrazado dentro de un subpath', () => {
    expect(() => resolveSafePath(baseDir, 'src/../../secrets')).toThrow('fuera de baseDir');
  });
});
