import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSpec } from './openapi-export';

describe('exportSpec (integration)', () => {
  let outputPath: string;
  let document: Record<string, unknown>;

  beforeAll(async () => {
    outputPath = join(tmpdir(), `openapi-test-${Date.now()}.json`);
    await exportSpec(outputPath);
    document = JSON.parse(readFileSync(outputPath, 'utf-8')) as Record<
      string,
      unknown
    >;
  }, 30_000);

  it('exports a valid OpenAPI 3.x document', () => {
    expect(document.openapi).toMatch(/^3\./);
  });

  it('sets info.title to "StreamTube API"', () => {
    const info = document.info as Record<string, unknown>;
    expect(info.title).toBe('StreamTube API');
  });

  it('sets info.version to "1.0"', () => {
    const info = document.info as Record<string, unknown>;
    expect(info.version).toBe('1.0');
  });

  it('includes access-token Bearer security scheme', () => {
    const components = document.components as Record<string, unknown>;
    const schemes = components.securitySchemes as Record<
      string,
      Record<string, unknown>
    >;
    expect(schemes['access-token']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
  });

  it('includes non-empty components.schemas from DTO inference', () => {
    const components = document.components as Record<string, unknown>;
    const schemas = components.schemas as Record<string, unknown>;
    expect(Object.keys(schemas).length).toBeGreaterThan(0);
  });

  it('includes ApiErrorEnvelope schema with expected properties', () => {
    const components = document.components as Record<string, unknown>;
    const schemas = components.schemas as Record<
      string,
      Record<string, unknown>
    >;
    expect(schemas['ApiErrorEnvelope']).toBeDefined();
    const props = schemas['ApiErrorEnvelope'].properties as Record<
      string,
      unknown
    >;
    expect(props).toHaveProperty('statusCode');
    expect(props).toHaveProperty('error');
    expect(props).toHaveProperty('message');
    expect(props).toHaveProperty('code');
  });

  it('has at least one path with a 401 response referencing ApiErrorEnvelope', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const apiErrorRef = '#/components/schemas/ApiErrorEnvelope';

    const hasRef = Object.values(paths).some((methods) =>
      Object.values(methods).some((operation) => {
        const responses = operation.responses as Record<
          string,
          Record<string, unknown>
        >;
        const r401 = responses?.['401'];
        if (!r401) return false;
        const content = r401.content as Record<string, Record<string, unknown>>;
        const jsonContent = content?.['application/json'];
        const schema = jsonContent?.schema as Record<string, unknown>;
        return schema?.['$ref'] === apiErrorRef;
      }),
    );

    expect(hasRef).toBe(true);
  });

  it('protected auth endpoints include access-token security requirement', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const protectedPaths = [
      { path: '/auth/logout', method: 'post' },
      { path: '/auth/me', method: 'get' },
    ];

    for (const { path, method } of protectedPaths) {
      const operation = paths[path]?.[method];
      expect(operation).toBeDefined();
      const security = operation?.security as Array<Record<string, unknown>>;
      expect(security).toBeDefined();
      expect(security.some((req) => 'access-token' in req)).toBe(true);
    }
  });

  it('all auth endpoints have a non-empty summary', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const authPaths = Object.entries(paths).filter(([p]) =>
      p.startsWith('/auth/'),
    );

    expect(authPaths.length).toBeGreaterThan(0);

    for (const [, methods] of authPaths) {
      for (const operation of Object.values(methods)) {
        expect(typeof operation.summary).toBe('string');
        expect((operation.summary as string).length).toBeGreaterThan(0);
      }
    }
  });

  describe('videos', () => {
    type Operation = Record<string, unknown>;
    const ERROR_REF = '#/components/schemas/ApiErrorEnvelope';

    const VIDEO_OPERATIONS = [
      { path: '/videos', method: 'post' },
      { path: '/videos/{videoId}', method: 'get' },
      { path: '/videos/{videoId}', method: 'delete' },
      { path: '/videos/{videoId}/upload/part-urls', method: 'post' },
      { path: '/videos/{videoId}/upload/parts', method: 'get' },
      { path: '/videos/{videoId}/upload/complete', method: 'post' },
      { path: '/videos/{videoId}/upload/restart', method: 'post' },
      { path: '/videos/{videoId}/stream', method: 'get' },
      { path: '/videos/{videoId}/download', method: 'get' },
    ];

    const operationOf = (path: string, method: string): Operation => {
      const paths = document.paths as Record<string, Record<string, Operation>>;
      return paths[path]?.[method];
    };

    it('documents the 9 video endpoints of the phase', () => {
      for (const { path, method } of VIDEO_OPERATIONS) {
        expect(operationOf(path, method)).toBeDefined();
      }
      const paths = document.paths as Record<string, Record<string, unknown>>;
      const documented = Object.entries(paths)
        .filter(([path]) => path.startsWith('/videos'))
        .flatMap(([, methods]) => Object.keys(methods));
      expect(documented).toHaveLength(VIDEO_OPERATIONS.length);
    });

    it.each(VIDEO_OPERATIONS)(
      '$method $path requires the access-token bearer and has a summary',
      ({ path, method }) => {
        const operation = operationOf(path, method);
        const security = operation.security as Array<Record<string, unknown>>;
        expect(security.some((req) => 'access-token' in req)).toBe(true);
        expect(typeof operation.summary).toBe('string');
        expect((operation.summary as string).length).toBeGreaterThan(0);
      },
    );

    it.each(VIDEO_OPERATIONS)(
      '$method $path documents its error responses with ApiErrorEnvelope',
      ({ path, method }) => {
        const responses = operationOf(path, method).responses as Record<
          string,
          { content?: Record<string, { schema?: { $ref?: string } }> }
        >;
        const errorCodes = Object.keys(responses).filter(
          (code) => Number(code) >= 400,
        );
        expect(errorCodes).toContain('401');
        for (const code of errorCodes) {
          expect(responses[code].content?.['application/json']?.schema).toEqual(
            { $ref: ERROR_REF },
          );
        }
      },
    );

    it('describes the request bodies of the upload endpoints with their properties', () => {
      const schemas = (
        document.components as {
          schemas: Record<string, { properties?: Record<string, unknown> }>;
        }
      ).schemas;
      const expected: Record<string, string[]> = {
        InitiateVideoUploadDto: [
          'filename',
          'mime_type',
          'size_bytes',
          'title',
        ],
        SignUploadPartsDto: ['part_numbers'],
        CompleteVideoUploadDto: ['parts'],
        CompleteUploadPartDto: ['part_number', 'etag'],
        RestartVideoUploadDto: ['size_bytes'],
        VideoResponseDto: ['id', 'status', 'thumbnail_url', 'duration_seconds'],
        PresignedUrlResponseDto: ['url', 'expires_at'],
      };
      for (const [name, properties] of Object.entries(expected)) {
        expect(Object.keys(schemas[name]?.properties ?? {})).toEqual(
          expect.arrayContaining(properties),
        );
      }
    });

    it('does not expose internal video fields in any schema', () => {
      const schemas = (
        document.components as {
          schemas: Record<string, { properties?: Record<string, unknown> }>;
        }
      ).schemas;
      for (const name of ['VideoResponseDto', 'VideoUploadResponseDto']) {
        const properties = Object.keys(schemas[name].properties ?? {});
        expect(properties).not.toEqual(expect.arrayContaining(['storage_key']));
        expect(properties).not.toContain('upload_id');
        expect(properties).not.toContain('channel_id');
      }
    });
  });
});
