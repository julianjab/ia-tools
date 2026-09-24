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

  it('corta un comando que produce salida infinita apenas supera maxOutputBytes', async () => {
    const tool = new BashRunTool({ baseDir, policy: { deny: [] }, maxOutputBytes: 32 });

    const result = JSON.parse(await tool.handler({ command: 'yes' }));

    expect(result.stdout.length).toBeLessThan(200); // truncado, no las decenas de MB que "yes" tiraría
    expect(result.stdout).toContain('truncado');
    expect(result.status).not.toBe('exit 0'); // lo matamos con SIGKILL, no terminó solo
  }, 10_000);

  it('mata el proceso (y no cuelga la promise) si supera timeoutMs', async () => {
    const tool = new BashRunTool({ baseDir, policy: { deny: [] }, timeoutMs: 200 });
    const start = Date.now();

    const result = JSON.parse(await tool.handler({ command: 'sleep 30' }));

    expect(Date.now() - start).toBeLessThan(5000); // no esperó los 30s del sleep
    expect(result.status).not.toBe('exit 0');
  }, 10_000);
});
