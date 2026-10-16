export interface ProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
  sizeBytes: number;
  // Bounded summary of ffprobe's `format` and `streams`, stored as jsonb.
  metadata: Record<string, unknown>;
}

// The subset of ffprobe's JSON output the service reads.
export interface FfprobeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  disposition?: { attached_pic?: number };
  [key: string]: unknown;
}

export interface FfprobeFormat {
  format_name?: string;
  duration?: string;
  size?: string;
  bit_rate?: string;
  [key: string]: unknown;
}

export interface FfprobeOutput {
  format?: FfprobeFormat;
  streams?: FfprobeStream[];
}
