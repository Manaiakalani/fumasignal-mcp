import pino from 'pino';

// CRITICAL: STDIO transport uses stdout for JSON-RPC. ALL logging must go to stderr.
export const logger = pino(
  {
    level: process.env.FUMASIGNAL_LOG_LEVEL ?? 'info',
    base: undefined,
  },
  pino.destination(2), // file descriptor 2 = stderr
);
