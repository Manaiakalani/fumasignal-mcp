import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildSource, parseOptions } from './cli.js';
import { logger } from './lib/logger.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const opts = parseOptions(process.argv);
  const source = buildSource(opts);
  const server = createServer(source);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('fumasignal-mcp: ready (stdio)');
}

main().catch((err: unknown) => {
  logger.error({ err: err instanceof Error ? err.stack ?? err.message : String(err) }, 'fatal');
  process.exit(1);
});
