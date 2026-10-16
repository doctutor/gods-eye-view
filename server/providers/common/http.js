export {
  readResponseTextCapped,
  readResponseJsonCapped,
  readResponseBytesCapped,
  coalesceProxyRequest,
} from '../../../src/sources/httpBody.js';

/**
 * Release a fetch Response this code has decided not to read.
 *
 * Until its body is consumed or cancelled, an undici Response keeps owning its
 * socket. Dropping one on an early return (a non-OK status, a refused redirect,
 * a declared size over the cap) leaves the parser paused on a body nobody will
 * drain, and when the upstream then closes the TLS socket undici can trip
 * `assert(!this.paused)` in Parser.finish and take the whole process down.
 * Every path that abandons a Response therefore goes through here. Never
 * throws: a body that is already locked, consumed or errored is fine to drop.
 * @param {Response|null|undefined} response - fetch() response, or nothing.
 * @returns {Promise<void>}
 */
export async function discardResponseBody(response) {
  try {
    await response?.body?.cancel();
  } catch {
    /* no-op */
  }
}

/**
 * Read a fetch Response body as text while enforcing a hard byte cap during
 * the read — so a malicious or buggy upstream that streams an unbounded body
 * (no/oversized Content-Length, chunked) can't OOM the proxy. Returns
 * { tooLarge, text }. Cancels the stream as soon as the cap is crossed.
 * @param {Response} upstream - fetch() response.
 * @param {number} maxBytes - hard ceiling on decoded bytes.
 * @returns {Promise<{tooLarge: boolean, text: string}>}
 */
export async function readCappedResponseText(upstream, maxBytes) {
  const declared = Number(upstream.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardResponseBody(upstream);
    return { tooLarge: true, text: '' };
  }
  if (
    !upstream.body ||
    typeof upstream.body[Symbol.asyncIterator] !== 'function'
  ) {
    const text = await upstream.text();
    return text.length > maxBytes
      ? { tooLarge: true, text: '' }
      : { tooLarge: false, text };
  }
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  for await (const chunk of upstream.body) {
    total += chunk.length;
    if (total > maxBytes) {
      try {
        await upstream.body.cancel();
      } catch {
        /* no-op */
      }
      return { tooLarge: true, text: '' };
    }
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  return { tooLarge: false, text };
}
