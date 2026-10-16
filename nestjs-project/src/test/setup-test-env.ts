// Runs after dotenv/config in every Jest suite (unit, integration, e2e).
// Isolates the suites from the app's real bucket and queue keys (TD-15).
process.env.S3_BUCKET = 'streamtube-videos-test';
process.env.QUEUE_PREFIX = 'bull-test';
