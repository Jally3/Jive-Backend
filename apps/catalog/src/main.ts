import { CatalogGenerator } from '../../../src/catalog.js';
import { CatalogService } from '../../../src/catalog-service.js';
import { loadConfig } from '../../../src/config.js';
import { createCatalogServer } from '../../../src/http-server.js';
import { Logger } from '../../../src/logger.js';
import { MonitoringService } from '../../../src/monitoring-service.js';
import { TmdbClient } from '../../../src/tmdb-client.js';
import { ArkRecommendationClient } from '../../../src/recommendation/ark-client.js';
import { RecommendationBudgetStore } from '../../../src/recommendation/budget-store.js';
import { RecommendationControls } from '../../../src/recommendation/controls.js';
import { RecommendationCursorCodec } from '../../../src/recommendation/cursor.js';
import { RecommendationService } from '../../../src/recommendation/service.js';
import { RecommendationMemoryStore } from '../../../src/recommendation/store.js';
import { AnonymousSubjectIssuer } from '../../../src/recommendation/subject.js';

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
let recommendation: RecommendationService | undefined;
let recommendationStore: RecommendationMemoryStore | undefined;
if (config.recommendation) {
  const recommendationConfig = config.recommendation;
  recommendationStore = new RecommendationMemoryStore({
    maxSessions: recommendationConfig.maxSessions,
    maxCacheEntries: recommendationConfig.maxCacheEntries,
    sessionTtlMs: recommendationConfig.sessionTtlMs,
    freshTtlMs: recommendationConfig.cacheFreshTtlMs,
    staleTtlMs: recommendationConfig.cacheStaleTtlMs,
    cleanupIntervalMs: recommendationConfig.cleanupIntervalMs,
  });
  recommendationStore.start();
  const controls = new RecommendationControls({
    subjectRateLimitPerMinute: recommendationConfig.subjectRateLimitPerMinute,
    sourceRateLimitPerMinute: recommendationConfig.sourceRateLimitPerMinute,
    maxRateLimitSubjects: 20_000,
    maxConcurrency: recommendationConfig.maxConcurrency,
    maxQueue: recommendationConfig.maxQueue,
  });
  const budget = new RecommendationBudgetStore({
    stateFile: recommendationConfig.budgetStateFile,
    timezone: recommendationConfig.budgetTimezone,
    maxSubjects: 20_000,
    subjectDailyCalls: recommendationConfig.subjectDailyCalls,
    subjectDailyTokens: recommendationConfig.subjectDailyTokens,
    globalDailyCalls: recommendationConfig.globalDailyCalls,
    globalDailyTokens: recommendationConfig.globalDailyTokens,
    globalDailyCostYuan: recommendationConfig.globalDailyCostYuan,
    inputYuanPerMillionTokens: recommendationConfig.arkInputYuanPerMillionTokens,
    outputYuanPerMillionTokens: recommendationConfig.arkOutputYuanPerMillionTokens,
  });
  await budget.start();
  recommendation = new RecommendationService({
    enabled: config.recommendationEnabled,
    promptVersion: recommendationConfig.promptVersion,
    modelVersion: recommendationConfig.arkModel,
    parameterVersion: `temperature=${recommendationConfig.arkTemperature};max=${recommendationConfig.arkMaxOutputTokens}`,
    maxOutputTokens: recommendationConfig.arkMaxOutputTokens,
    minItemsForNextPage: recommendationConfig.minItemsForNextPage,
    fingerprintSecret: recommendationConfig.fingerprintSecret,
    subjectIssuer: new AnonymousSubjectIssuer(recommendationConfig.subjectSecret),
    cursorCodec: new RecommendationCursorCodec(recommendationConfig.cursorSecret),
    store: recommendationStore,
    controls,
    budget,
    ark: new ArkRecommendationClient({
      apiKey: recommendationConfig.arkApiKey,
      baseUrl: recommendationConfig.arkBaseUrl,
      model: recommendationConfig.arkModel,
      timeoutMs: recommendationConfig.arkRequestTimeoutMs,
      maxOutputTokens: recommendationConfig.arkMaxOutputTokens,
      maxResponseBytes: recommendationConfig.arkMaxResponseBytes,
      temperature: recommendationConfig.arkTemperature,
    }),
    logger,
  });
}
const server = createCatalogServer({
  catalog,
  logger,
  rateLimitPerMinute: config.rateLimitPerMinute,
  trustProxy: config.trustProxy,
  monitoring,
  adminEnabled: config.adminEnabled,
  tmdbDiagnostics: () => tmdb.diagnostics(),
  ...(recommendation ? { recommendation } : {}),
});
server.listen(config.port, config.host, () => {
  logger.info('catalog server listening', { host: config.host, port: config.port });
});

const shutdown = (): void => {
  catalog.stop();
  recommendationStore?.stop();
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
