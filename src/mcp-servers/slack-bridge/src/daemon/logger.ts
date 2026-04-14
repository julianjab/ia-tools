import { createLogger } from '../logger.js';

const logPath = process.env.DAEMON_LOG?.trim() || '/tmp/slack-bridge/daemon-logs.json';

const { log, warn, error, debug, logPath: resolvedPath } = createLogger({
  logPath,
  label: 'daemon',
});

export { log, warn, error, debug };
export { resolvedPath as logPath };
