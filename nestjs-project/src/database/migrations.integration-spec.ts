import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { Video } from '../videos/entities/video.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1792026456492 } from './migrations/1792026456492-CreateVideos';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
        ],
      },
    );

    await dataSource.initialize();

    await Promise.all([
      ...MANAGED_TABLES.map((table) =>
        dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`),
      ),
      dataSource.query(`DROP TABLE IF EXISTS "migrations" CASCADE`),
    ]);
  });

  afterAll(async () => {
    // The second test undoes the last migration, leaving token tables missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('should apply all migrations and create all four tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(2);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
    ]);
  });

  it('should revert the last migration and remove token tables', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [['refresh_tokens', 'verification_tokens']],
    );
    expect(result).toHaveLength(0);
  });
});

describe('CreateVideos migration (integration)', () => {
  const VIDEO_COLUMNS = [
    'id',
    'public_id',
    'channel_id',
    'title',
    'status',
    'failure_reason',
    'original_filename',
    'mime_type',
    'size_bytes',
    'storage_key',
    'thumbnail_key',
    'upload_id',
    'part_size_bytes',
    'part_count',
    'duration_seconds',
    'width',
    'height',
    'video_codec',
    'metadata',
    'created_at',
    'updated_at',
  ];
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1792026456492,
        ],
      },
    );
    await dataSource.initialize();

    // Full reset, enums included, so this block starts from an empty schema
    // regardless of what a previous suite or run left behind.
    for (const table of [...MANAGED_TABLES, 'videos', 'migrations']) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }
    for (const type of [
      'videos_status_enum',
      'verification_tokens_type_enum',
    ]) {
      await dataSource.query(`DROP TYPE IF EXISTS "${type}" CASCADE`);
    }
  });

  afterAll(async () => {
    // The down test removes `videos`; re-apply so the shared DB ends migrated.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('should create the videos table, the status enum and its constraints on up', async () => {
    const ranMigrations = await dataSource.runMigrations();
    expect(ranMigrations.map((m) => m.name)).toEqual([
      'CreateUsersAndChannels1775687773260',
      'CreateAuthTokens1777579850478',
      'CreateVideos1792026456492',
    ]);

    const columns = await dataSource.query<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'videos'
       ORDER BY ordinal_position`,
    );
    expect(columns.map((c) => c.column_name)).toEqual(VIDEO_COLUMNS);

    const enumLabels = await dataSource.query<{ enumlabel: string }[]>(
      `SELECT e.enumlabel FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'videos_status_enum'
       ORDER BY e.enumsortorder`,
    );
    expect(enumLabels.map((e) => e.enumlabel)).toEqual([
      'draft',
      'processing',
      'ready',
      'failed',
    ]);

    const [defaults] = await dataSource.query<{ column_default: string }[]>(
      `SELECT column_default FROM information_schema.columns
       WHERE table_name = 'videos' AND column_name = 'status'`,
    );
    expect(defaults.column_default).toContain("'draft'");

    const constraints = await dataSource.query<
      { contype: string; delete_rule: string | null; definition: string }[]
    >(
      `SELECT contype, confdeltype AS delete_rule, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint WHERE conrelid = 'videos'::regclass`,
    );
    const unique = constraints.find((c) => c.contype === 'u');
    const foreignKey = constraints.find((c) => c.contype === 'f');
    expect(unique?.definition).toBe('UNIQUE (public_id)');
    expect(foreignKey?.definition).toContain(
      'FOREIGN KEY (channel_id) REFERENCES channels(id)',
    );
    expect(foreignKey?.delete_rule).toBe('c');

    const indexes = await dataSource.query<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'videos'`,
    );
    expect(indexes.some((i) => i.indexdef.endsWith('(channel_id)'))).toBe(true);
  });

  it('should drop the videos table and the status enum on down, keeping the rest', async () => {
    await dataSource.undoLastMigration();

    const [videos] = await dataSource.query<{ regclass: string | null }[]>(
      `SELECT to_regclass('public.videos') AS regclass`,
    );
    expect(videos.regclass).toBeNull();

    const enumTypes = await dataSource.query<{ typname: string }[]>(
      `SELECT typname FROM pg_type WHERE typname = 'videos_status_enum'`,
    );
    expect(enumTypes).toHaveLength(0);

    const [channels] = await dataSource.query<{ regclass: string | null }[]>(
      `SELECT to_regclass('public.channels') AS regclass`,
    );
    expect(channels.regclass).not.toBeNull();
  });
});
