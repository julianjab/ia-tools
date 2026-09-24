import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsWriteTool } from '../FsWriteTool.js';

let baseDir: string;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'fs-tools-fswrite-'));
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

describe('fs_write', () => {
  it('crea un archivo nuevo con el contenido dado', async () => {
    const tool = new FsWriteTool(baseDir);

    await tool.handler({ path: 'a.txt', content: 'hola' });

    expect(await readFile(join(baseDir, 'a.txt'), 'utf-8')).toBe('hola');
  });

  it('crea los directorios padre que hagan falta', async () => {
    const tool = new FsWriteTool(baseDir);

    await tool.handler({ path: 'src/deep/nested/file.ts', content: 'x' });

    expect(await readFile(join(baseDir, 'src/deep/nested/file.ts'), 'utf-8')).toBe('x');
  });

  it('sobreescribe un archivo existente por completo', async () => {
    const tool = new FsWriteTool(baseDir);
    await tool.handler({ path: 'a.txt', content: 'viejo contenido largo' });

    await tool.handler({ path: 'a.txt', content: 'nuevo' });

    expect(await readFile(join(baseDir, 'a.txt'), 'utf-8')).toBe('nuevo');
  });

  it('rechaza un path que se escapa de baseDir', async () => {
    const tool = new FsWriteTool(baseDir);
    await expect(tool.handler({ path: '../evil.txt', content: 'x' })).rejects.toThrow(
      'fuera de baseDir',
    );
  });
});
