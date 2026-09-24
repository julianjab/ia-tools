import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BashRunTool } from '../BashRunTool.js';

let baseDir: string;

beforeEach(async () => {
  // realpath: en macOS $TMPDIR resuelve bajo un symlink (/tmp -> /private/tmp) — `pwd` (y
  // cualquier proceso real) devuelve el path YA resuelto, así que comparamos contra eso.
  baseDir = await realpath(await mkdtemp(join(tmpdir(), 'shell-tools-bashrun-')));
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

describe('bash_run', () => {
  it('corre un comando permitido y devuelve stdout', async () => {
    const tool = new BashRunTool({ baseDir, policy: { deny: [] } });

    const result = JSON.parse(await tool.handler({ command: 'echo hola' }));

    expect(result.status).toBe('exit 0');
    expect(result.stdout.trim()).toBe('hola');
  });

  it('rechaza un comando denegado por la policy sin ejecutarlo', async () => {
    const tool = new BashRunTool({ baseDir, policy: { deny: ['rm *'] } });

    await expect(tool.handler({ command: 'rm -rf /' })).rejects.toThrow('denegado');
  });

  it('rechaza un comando fuera de un allowlist explícito', async () => {
    const tool = new BashRunTool({ baseDir, policy: { allow: ['echo *'], deny: [] } });

    await expect(tool.handler({ command: 'ls' })).rejects.toThrow('allowlist');
  });

  it('rechaza un binario invocado por path absoluto — no puede saltarse la deny-list así', async () => {
    const tool = new BashRunTool({ baseDir, policy: { deny: ['rm *'] } });

    await expect(tool.handler({ command: '/bin/rm -rf /' })).rejects.toThrow('path');
  });

  it('rechaza un binario invocado por path relativo', async () => {
    const tool = new BashRunTool({ baseDir, policy: { deny: [] } });

    await expect(tool.handler({ command: './evil.sh' })).rejects.toThrow('path');
    await expect(tool.handler({ command: 'bin/evil' })).rejects.toThrow('path');
  });

  it('corre en baseDir — un comando que depende del cwd lo confirma', async () => {
    const tool = new BashRunTool({ baseDir, policy: { deny: [] } });

    const result = JSON.parse(await tool.handler({ command: 'pwd' }));

    expect(result.stdout.trim()).toBe(baseDir);
  });

  it('reporta un exit code no-cero sin tirar — el modelo decide qué hacer con eso', async () => {
    const tool = new BashRunTool({ baseDir, policy: { deny: [] } });

    const result = JSON.parse(await tool.handler({ command: 'ls no-existe-seguro' }));

    expect(result.status).not.toBe('exit 0');
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});
