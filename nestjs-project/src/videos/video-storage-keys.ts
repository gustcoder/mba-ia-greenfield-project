// Single bucket, one prefix per video (internal uuid, never the public id).
export const videoPrefix = (id: string): string => `videos/${id}/`;
export const originalKey = (id: string): string => `${videoPrefix(id)}original`;
export const thumbnailKey = (id: string): string =>
  `${videoPrefix(id)}thumbnail.jpg`;
