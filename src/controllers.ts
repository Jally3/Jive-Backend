import {
  ArgumentsHost,
  Body,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  Headers,
  HttpException,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';
import type { Environment } from '../packages/config/src/index.js';
import {
  createId,
  DomainError,
  historySchema,
  installationSchema,
  paginationSchema,
  playbackEventSchema,
  playbackRequestSchema,
  searchQuerySchema,
  success,
  videoListQuerySchema,
} from '../packages/contracts/src/index.js';
import { metrics } from '../packages/observability/src/index.js';
import {
  AdminService,
  CatalogService,
  HealthService,
  HistoryService,
  InstallationService,
  PlaybackService,
} from './core.js';

type Request = FastifyRequest & { requestId?: string };
const reqId = (request: Request): string => request.requestId ?? createId('req');

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<FastifyReply>();
    const request = host.switchToHttp().getRequest<Request>();
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = '服务器内部错误';
    let retryable = false;
    if (error instanceof DomainError) {
      status = error.status;
      code = error.code;
      message = error.message;
      retryable = error.retryable;
    } else if (error instanceof ZodError) {
      status = 400;
      code = 'VALIDATION_FAILED';
      message = error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      code = status === 429 ? 'RATE_LIMITED' : 'VALIDATION_FAILED';
      message = error.message;
      retryable = status === 429;
    }
    if (status >= 500)
      request.log.error(
        {
          err: error instanceof Error ? { name: error.name, message: error.message } : 'unknown',
          error_code: code,
          request_id: reqId(request),
        },
        'request failed',
      );
    void response.status(status).send({
      data: null,
      meta: {},
      error: { code, message, retryable },
      request_id: reqId(request),
    });
  }
}

@ApiTags('app')
@Controller('api/v1')
export class AppController {
  constructor(
    @Inject(InstallationService) private readonly installations: InstallationService,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(HistoryService) private readonly history: HistoryService,
    @Inject(PlaybackService) private readonly playback: PlaybackService,
  ) {}
  private auth(header?: string) {
    return this.installations.authenticate(header);
  }
  @Post('installations')
  @ApiOperation({ summary: 'Register an anonymous app installation' })
  async install(@Body() body: unknown, @Req() request: Request) {
    const input = installationSchema.parse(body);
    return success(
      await this.installations.register(input.platform, input.app_version),
      reqId(request),
    );
  }
  @Get('categories') async categories(@Req() request: Request) {
    return success(await this.catalog.listCategories(), reqId(request));
  }
  @Get('videos') async videos(@Query() query: unknown, @Req() request: Request) {
    const input = videoListQuerySchema.parse(query);
    const result = await this.catalog.list({
      page: input.page,
      page_size: input.page_size,
      sort: input.sort,
      ...(input.category_id ? { category_id: input.category_id } : {}),
    });
    return success(result.items, reqId(request), result.pagination);
  }
  @Get('videos/search') async search(@Query() query: unknown, @Req() request: Request) {
    const input = searchQuerySchema.parse(query);
    const result = await this.catalog.list({ ...input, sort: 'latest', q: input.q });
    return success(result.items, reqId(request), result.pagination);
  }
  @Get('videos/:videoId') async detail(@Param('videoId') videoId: string, @Req() request: Request) {
    return success(await this.catalog.detail(videoId), reqId(request));
  }
  @Post('videos/:videoId/episodes/:episodeId/playback') @ApiBearerAuth() async resolve(
    @Param('videoId') videoId: string,
    @Param('episodeId') episodeId: string,
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Req() request: Request,
  ) {
    const owner = await this.auth(authorization);
    const input = playbackRequestSchema.parse(body ?? {});
    return success(
      await this.playback.resolve(owner, videoId, episodeId, input.preferred_source),
      reqId(request),
    );
  }
  @Get('watch-history') @ApiBearerAuth() async historyList(
    @Query() query: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Req() request: Request,
  ) {
    const owner = await this.auth(authorization);
    const page = paginationSchema.parse(query);
    return success(await this.history.list(owner, page.page, page.page_size), reqId(request), page);
  }
  @Put('watch-history/:videoId/:episodeId') @ApiBearerAuth() async historyPut(
    @Param('videoId') videoId: string,
    @Param('episodeId') episodeId: string,
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Req() request: Request,
  ) {
    const owner = await this.auth(authorization);
    return success(
      await this.history.put(owner, videoId, episodeId, historySchema.parse(body)),
      reqId(request),
    );
  }
  @Post('playback-events') @ApiBearerAuth() async event(
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Req() request: Request,
  ) {
    const owner = await this.auth(authorization);
    return success(
      await this.playback.event(owner, playbackEventSchema.parse(body)),
      reqId(request),
    );
  }
}

const sourcePatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
    name: z.string().min(1).max(100).optional(),
  })
  .refine((v) => Object.keys(v).length > 0);
const linePatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0);
const triggerSchema = z.object({ type: z.enum(['full', 'incremental']).default('full') });
const videoPatchSchema = z.object({ enabled: z.boolean() });
const mappingSchema = z.object({ video_id: z.string().startsWith('vid_') });
const sourceCreateSchema = z.object({
  code: z.string().regex(/^[a-z0-9-]{2,32}$/),
  name: z.string().min(1).max(100),
  adapter_name: z.string().min(1).max(64),
  base_url: z.string().url(),
  priority: z.number().int().min(0).max(10_000).default(100),
});

@ApiTags('admin')
@ApiBearerAuth()
@Controller('api/v1/admin')
export class AdminController {
  constructor(
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject('ENV') private readonly env: Environment,
  ) {}
  private guard(header?: string) {
    this.admin.authenticate(header, this.env.ADMIN_AUTH_TOKEN);
  }
  @Get('sources') async sources(
    @Headers('authorization') auth: string | undefined,
    @Req() request: Request,
  ) {
    this.guard(auth);
    return success(await this.admin.sources(), reqId(request));
  }
  @Post('sources') async createSource(
    @Body() body: unknown,
    @Headers('authorization') auth: string | undefined,
    @Req() request: Request,
  ) {
    this.guard(auth);
    return success(
      await this.admin.addSource(sourceCreateSchema.parse(body), reqId(request)),
      reqId(request),
    );
  }
  @Patch('sources/:id') async source(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') auth: string | undefined,
    @Req() request: Request,
  ) {
    this.guard(auth);
    const parsed = sourcePatchSchema.parse(body);
    const input = {
      ...(parsed.enabled !== undefined ? { enabled: parsed.enabled } : {}),
      ...(parsed.priority !== undefined ? { priority: parsed.priority } : {}),
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
    };
    return success(await this.admin.patchSource(id, input, reqId(request)), reqId(request));
  }
  @Patch('lines/:id') async line(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') auth: string | undefined,
    @Req() request: Request,
  ) {
    this.guard(auth);
    const parsed = linePatchSchema.parse(body);
    const input = {
      ...(parsed.enabled !== undefined ? { enabled: parsed.enabled } : {}),
      ...(parsed.priority !== undefined ? { priority: parsed.priority } : {}),
    };
    return success(await this.admin.patchLine(id, input, reqId(request)), reqId(request));
  }
  @Post('sources/:id/sync') async sync(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') auth: string | undefined,
    @Req() request: Request,
  ) {
    this.guard(auth);
    const input = triggerSchema.parse(body ?? {});
    return success(await this.admin.trigger(id, input.type), reqId(request));
  }
  @Get('sync-runs') async runs(
    @Query('source_id') sourceId: string | undefined,
    @Headers('authorization') auth: string | undefined,
    @Req() request: Request,
  ) {
    this.guard(auth);
    return success(await this.admin.runs(sourceId), reqId(request));
  }
  @Patch('videos/:id') async video(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') auth: string | undefined,
    @Req() request: Request,
  ) {
    this.guard(auth);
    const input = videoPatchSchema.parse(body);
    return success(await this.admin.toggleVideo(id, input.enabled, reqId(request)), reqId(request));
  }
  @Put('source-videos/:id/mapping') async mapping(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') auth: string | undefined,
    @Req() request: Request,
  ) {
    this.guard(auth);
    const input = mappingSchema.parse(body);
    return success(await this.admin.remap(id, input.video_id, reqId(request)), reqId(request));
  }
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}
  @Get('live') live() {
    return this.health.live();
  }
  @Get('ready') ready() {
    return this.health.ready();
  }
}
@Controller()
export class MetricsController {
  @Get('metrics') async metrics(@Res() reply: FastifyReply) {
    return reply.header('content-type', metrics.contentType).send(await metrics.metrics());
  }
}
