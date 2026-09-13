import { CatalogGenerator } from '../../../src/catalog.js';
import { CatalogService } from '../../../src/catalog-service.js';
import { loadConfig } from '../../../src/config.js';
import { createCatalogServer } from '../../../src/http-server.js';
import { Logger } from '../../../src/logger.js';
import { MonitoringService } from '../../../src/monitoring-service.js';
import { TmdbClient } from '../../../src/tmdb-client.js';

const config = loadConfig();
const logger = new Logger(config.logLevel);
const monitoring = new MonitoringService({
  logger,
  ...(config.monitoringStateFile ? { stateFile: config.monitoringStateFile } : {}),
  retentionDays: config.monitoringRetentionDays,
  timezone: config.monitoringTimezone,
  saveIntervalMs: config.monitoringSaveIntervalMs,
});
await monitoring.start();
const tmdb = new TmdbClient({
  token: config.tmdbToken,
  baseUrl: config.tmdbBaseUrl,
  concurrency: config.tmdbConcurrency,
  pages: config.tmdbPages,
  timeoutMs: config.requestTimeoutMs,
  monitoring,
});
const catalog = new CatalogService(
  new CatalogGenerator(tmdb),
  logger,
  config.stateFile,
  monitoring,
);
await catalog.start();
const server = createCatalogServer({
  catalog,
  logger,
  rateLimitPerMinute: config.rateLimitPerMinute,
  trustProxy: config.trustProxy,
  monitoring,
  adminEnabled: config.adminEnabled,
  tmdbDiagnostics: () => tmdb.diagnostics(),
});
server.listen(config.port, config.host, () => {
  logger.info('catalog server listening', { host: config.host, port: config.port });
});

const shutdown = (): void => {
  catalog.stop();
  server.close(async (error) => {
    try {
      await monitoring.stop();
    } catch (monitoringError) {
      logger.error('monitoring shutdown save failed', {
        error: monitoringError instanceof Error ? monitoringError.message : 'unknown error',
      });
      error ??=
        monitoringError instanceof Error ? monitoringError : new Error('monitoring save failed');
    }
    if (error) logger.error('server shutdown failed', { error: error.message });
    process.exitCode = error ? 1 : 0;
  });
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
