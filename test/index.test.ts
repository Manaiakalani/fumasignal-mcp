import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `src/index.ts` runs `main()` as a side effect of being imported, so each
// case here resets the module registry and re-imports it with the whole
// startup collaborator set mocked out. That keeps the assertions on the
// entrypoint's own wiring - the order it builds things in, and what it does
// when any step throws - rather than on the CLI/server internals, which have
// their own suites.
const parseOptions = vi.fn();
const buildSource = vi.fn();
const createServer = vi.fn();
const connect = vi.fn();
const loggerInfo = vi.fn();
const loggerError = vi.fn();

vi.mock('../src/cli.js', () => ({
  parseOptions: (...args: unknown[]) => parseOptions(...args) as unknown,
  buildSource: (...args: unknown[]) => buildSource(...args) as unknown,
}));

vi.mock('../src/server.js', () => ({
  createServer: (...args: unknown[]) => createServer(...args) as unknown,
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: {
    info: (...args: unknown[]) => loggerInfo(...args),
    error: (...args: unknown[]) => loggerError(...args),
  },
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {
    readonly kind = 'stdio';
  },
}));

/**
 * Let the `main().catch(...)` continuation (a microtask chained onto an
 * already-settled promise) run before asserting.
 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('entrypoint startup', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    parseOptions.mockReset();
    buildSource.mockReset();
    createServer.mockReset();
    connect.mockReset();
    loggerInfo.mockReset();
    loggerError.mockReset();
    createServer.mockReturnValue({ connect });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('parses argv, builds the source, connects over stdio, and logs readiness', async () => {
    const opts = { url: 'https://example.com' };
    const source = { kind: 'remote' };
    parseOptions.mockReturnValue(opts);
    buildSource.mockReturnValue(source);
    connect.mockResolvedValue(undefined);

    await import('../src/index.js');
    await flushMicrotasks();

    expect(parseOptions).toHaveBeenCalledWith(process.argv);
    expect(buildSource).toHaveBeenCalledWith(opts);
    expect(createServer).toHaveBeenCalledWith(source);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(loggerInfo).toHaveBeenCalledWith('fumasignal-mcp: ready (stdio)');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('logs the stack and exits non-zero when option parsing throws', async () => {
    // A bad `--cache-ttl`/`--url` surfaces here as a thrown Error. Without
    // the top-level catch this would be an unhandled rejection, which exits
    // with a Node-generated trace and no useful log line.
    const err = new Error('bad --url');
    parseOptions.mockImplementation(() => {
      throw err;
    });

    await import('../src/index.js');
    await flushMicrotasks();

    expect(loggerError).toHaveBeenCalledTimes(1);
    const [payload, msg] = loggerError.mock.calls[0] as [{ err: string }, string];
    expect(msg).toBe('fatal');
    expect(payload.err).toContain('bad --url');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(loggerInfo).not.toHaveBeenCalled();
  });

  it('logs and exits non-zero when the transport connection rejects', async () => {
    parseOptions.mockReturnValue({});
    buildSource.mockReturnValue({});
    connect.mockRejectedValue(new Error('stdio unavailable'));

    await import('../src/index.js');
    await flushMicrotasks();

    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(loggerInfo).not.toHaveBeenCalled();
  });

  it('stringifies a non-Error throw instead of logging undefined', async () => {
    parseOptions.mockImplementation(() => {
      throw 'plain string failure';
    });

    await import('../src/index.js');
    await flushMicrotasks();

    const [payload] = loggerError.mock.calls[0] as [{ err: string }, string];
    expect(payload.err).toBe('plain string failure');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
