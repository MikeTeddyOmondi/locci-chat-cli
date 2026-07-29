type ShutdownHandler = () => void | Promise<void>;

interface ShutdownOptions {
  /** Hard cap before we stop waiting for cleanup and force-exit. */
  timeoutMs?: number;
  logger?: (msg: string) => void;
}

const handlers: { name: string; fn: ShutdownHandler }[] = [];
let started = false;

/**
 * Register a cleanup function to run on SIGTERM/SIGINT. Handlers run in
 * reverse registration order (LIFO), so things torn down last were set up
 * first — e.g. register the HTTP server early and MCP clients later, and the
 * clients close before the server.
 *
 *   onShutdown('mcp: everest', () => everestClient.close());
 */
export function onShutdown(name: string, fn: ShutdownHandler): void {
  handlers.push({ name, fn });
}

/** Wire SIGTERM/SIGINT once. Idempotent; safe to call a single time at boot. */
export function installShutdown(options: ShutdownOptions = {}): void {
  const { timeoutMs = 10_000, logger = console.error } = options;

  const run = async (signal: NodeJS.Signals): Promise<void> => {
    if (started) {
      // A second signal (e.g. impatient double Ctrl+C) forces an exit now.
      logger(`\n${signal} again — forcing exit.`);
      process.exit(1);
    }
    started = true;
    logger(`\n${signal} received — shutting down gracefully…`);

    const force = setTimeout(() => {
      logger(`Cleanup exceeded ${timeoutMs}ms — forcing exit.`);
      process.exit(1);
    }, timeoutMs);
    force.unref();

    for (const { name, fn } of [...handlers].reverse()) {
      try {
        await fn();
        logger(`  ✓ ${name}`);
      } catch (err) {
        logger(`  ✗ ${name}: ${(err as Error).message}`);
      }
    }

    clearTimeout(force);
    logger('Shutdown complete.');
    process.exit(0);
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => void run(signal));
  }
}
