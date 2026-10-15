import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module';

// Entrypoint of the video worker: a standalone application context (no HTTP
// server) whose only job is to consume the video-processing queue.
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // SIGTERM/SIGINT close the BullMQ worker (waiting for the active job) and
  // the database connection before the process exits.
  app.enableShutdownHooks();
  new Logger('Worker').log('Video worker started');
}

void bootstrap();
