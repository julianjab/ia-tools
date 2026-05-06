/**
 * ConfigWatcher — watches a single file for changes and invokes a callback,
 * debounced. Watches the parent directory (not the file itself) so editors
 * that replace-on-save don't break the watcher.
 *
 * Usage:
 *   const watcher = new ConfigWatcher({
 *     configPath: '.claude/.slack-bridge.json',
 *     onChange: () => this.reloadFromConfig(),
 *     logger,
 *   });
 *   watcher.start();
 *   // ...
 *   watcher.stop();
 */

import { type FSWatcher, watch } from 'node:fs';
import { basename, dirname } from 'node:path';

export interface ConfigWatcherLogger {
  log: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface ConfigWatcherOptions {
  /** Absolute path to the file to watch. */
  configPath: string;
  /** Invoked after the debounce window when the file changes. */
  onChange: () => void | Promise<void>;
  /** Debounce window in ms (default: 250). */
  debounceMs?: number;
  /** Optional logger. Defaults to no-op. */
  logger?: ConfigWatcherLogger;
}

const NOOP_LOGGER: ConfigWatcherLogger = { log: () => {}, warn: () => {} };

export class ConfigWatcher {
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly configPath: string;
  private readonly onChange: () => void | Promise<void>;
  private readonly debounceMs: number;
  private readonly logger: ConfigWatcherLogger;

  constructor(opts: ConfigWatcherOptions) {
    this.configPath = opts.configPath;
    this.onChange = opts.onChange;
    this.debounceMs = opts.debounceMs ?? 250;
    this.logger = opts.logger ?? NOOP_LOGGER;
  }

  /** Start watching. No-op if already started. */
  start(): void {
    if (this.watcher) return;
    const dir = dirname(this.configPath);
    const file = basename(this.configPath);
    try {
      this.watcher = watch(dir, (_event, filename) => {
        if (filename !== file) return;
        this.scheduleReload();
      });
      this.watcher.on('error', (err) => this.logger.warn(`[config-watcher] error: ${err}`));
      this.logger.log(`[config-watcher] watching ${this.configPath}`);
    } catch (err) {
      this.logger.warn(`[config-watcher] could not start: ${err}`);
    }
  }

  /** Stop watching and clear any pending reload. */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
  }

  private scheduleReload(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      Promise.resolve(this.onChange()).catch((err) =>
        this.logger.warn(`[config-watcher] onChange failed: ${err}`),
      );
    }, this.debounceMs);
  }
}
