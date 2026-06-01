import mime from 'mime-types';

const FALLBACK_EXT: Record<string, string> = {
  'text/html': 'html',
  'text/css': 'css',
  'application/javascript': 'js',
  'text/javascript': 'js',
  'application/json': 'json',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'font/woff2': 'woff2',
  'font/woff': 'woff',
  'font/ttf': 'ttf',
  'application/font-woff2': 'woff2',
  'application/font-woff': 'woff',
  'video/mp4': 'mp4',
};

export function extensionFromContentType(contentType: string | undefined): string | undefined {
  if (!contentType) return undefined;
  const base = contentType.split(';')[0]?.trim().toLowerCase();
  if (!base) return undefined;
  const ext = mime.extension(base);
  if (ext) return ext;
  return FALLBACK_EXT[base];
}

export function isTextual(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return (
    base.startsWith('text/') ||
    base === 'application/javascript' ||
    base === 'text/javascript' ||
    base === 'application/json' ||
    base === 'image/svg+xml' ||
    base === 'application/xml'
  );
}
