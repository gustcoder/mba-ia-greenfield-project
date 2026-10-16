import { spawn } from 'child_process';
import { Injectable } from '@nestjs/common';
import {
  MAX_RUNNER_STDERR_CHARS,
  MAX_RUNNER_STDOUT_BYTES,
} from './media.constants';
import { FfmpegExecutionError } from './media.errors';

export interface FfmpegRunResult {
  stdout: Buffer;
  stderr: string;
}

// An input URL is a presigned storage URL: its query string carries the
// signature, which must never reach logs or error messages.
const URL_QUERY = /(https?:\/\/[^\s?"']+)\?[^\s"']*/g;
const redactUrlQueries = (text: string): string =>
  text.replace(URL_QUERY, '$1?<redacted>');

@Injectable()
export class FfmpegRunner {
  // No shell: arguments are passed as an array, never interpreted.
  run(
    binary: string,
    args: string[],
    timeoutMs: number,
  ): Promise<FfmpegRunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdoutChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderr = '';
      let failure: FfmpegExecutionError | undefined;

      const fail = (error: FfmpegExecutionError) => {
        failure ??= error;
        child.kill('SIGKILL');
      };
      const describe = (suffix: string) =>
        `${binary} ${suffix}: ${redactUrlQueries(stderr).trim().slice(-500)}`;

      const timer = setTimeout(() => {
        fail(
          new FfmpegExecutionError(
            describe(`timed out after ${timeoutMs}ms`),
            'timeout',
            redactUrlQueries(stderr),
          ),
        );
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_RUNNER_STDOUT_BYTES) {
          fail(
            new FfmpegExecutionError(
              describe('output exceeded the size limit'),
              'output-limit',
              redactUrlQueries(stderr),
            ),
          );
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(
          -MAX_RUNNER_STDERR_CHARS,
        );
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        reject(
          new FfmpegExecutionError(
            `${binary} could not be started: ${error.message}`,
            'spawn',
            '',
            null,
            { cause: error },
          ),
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (failure) {
          reject(failure);
        } else if (code !== 0) {
          reject(
            new FfmpegExecutionError(
              describe(`exited with code ${code}`),
              'exit-code',
              redactUrlQueries(stderr),
              code,
            ),
          );
        } else {
          resolve({
            stdout: Buffer.concat(stdoutChunks),
            stderr: redactUrlQueries(stderr),
          });
        }
      });
    });
  }
}
