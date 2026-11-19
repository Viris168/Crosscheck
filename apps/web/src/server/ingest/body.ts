import { HttpError } from '@app/shared';

/**
 * Reads the request body as UTF-8 text, refusing anything over `maxBytes`.
 * - `Content-Length` over the limit → 413 before reading anything.
 * - Otherwise the stream is read chunk by chunk and cancelled as soon as it passes the limit
 *   (a lying or missing `Content-Length` can't make us buffer more than `maxBytes`).
 */
export async function readBodyWithLimit(req: Request, maxBytes: number): Promise<string> {
  const declared = req.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    throw new HttpError('payload_too_large', `Body exceeds ${maxBytes} bytes`);
  }
  if (!req.body) return '';

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError('payload_too_large', `Body exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}
