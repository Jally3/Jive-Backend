import type {
  ResolvedSourcePlayback,
  SourceRequestContext,
  SourceVideoDetail,
  SourceVideoPage,
  VodSourceAdapter,
} from '../../../source-sdk/src/index.js';
import { SourceError } from '../../../source-sdk/src/index.js';

/** Reference implementation proving that adapters are registry-driven, not coupled to business modules. */
export class SourceBAdapter implements VodSourceAdapter {
  readonly sourceCode = 'source-b';
  readonly capabilities = {
    search: false,
    categories: false,
    incrementalSync: false,
    expiringPlaybackUrl: true,
    requiresPlaybackHeaders: false,
  } as const;
  async listCategories() {
    return [];
  }
  async listVideos(): Promise<SourceVideoPage> {
    throw new SourceError('unavailable', 'Source B is not configured', false);
  }
  async getVideoDetail(): Promise<SourceVideoDetail> {
    throw new SourceError('unavailable', 'Source B is not configured', false);
  }
  async resolvePlayback(): Promise<ResolvedSourcePlayback[]> {
    throw new SourceError('unavailable', 'Source B is not configured', false);
  }
  async healthCheck(context: SourceRequestContext) {
    void context;
    return { healthy: false, latencyMs: 0, message: 'not configured' };
  }
}
