import { CatalogGenerator } from '../../../src/catalog.js';
import { CatalogService } from '../../../src/catalog-service.js';
import { loadConfig } from '../../../src/config.js';
import { createCatalogServer } from '../../../src/http-server.js';
import { Logger } from '../../../src/logger.js';
import { TmdbClient } from '../../../src/tmdb-client.js';

const config = loadConfig();
const logger = new Logger(config.logLevel);
const tmdb = new TmdbClient({
  token: config.tmdbToken,
  baseUrl: config.tmdbBaseUrl,
  concurrency: config.tmdbConcurrency,
  pages: config.tmdbPages,
  timeoutMs: config.requestTimeoutMs,
});
const catalog = new CatalogService(new CatalogGenerator(tmdb), logger, config.stateFile);
await catalog.start();
const server = createCatalogServer({
  catalog,
  logger,
  rateLimitPerMinute: config.rateLimitPerMinute,
  trustProxy: config.trustProxy,
});
server.listen(config.port, config.host, () => {
  logger.info('catalog server listening', { host: config.host, port: config.port });
});

const shutdown = (): void => {
  catalog.stop();
  server.close((error) => {
    if (error) logger.error('server shutdown failed', { error: error.message });
    process.exitCode = error ? 1 : 0;
  });
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
