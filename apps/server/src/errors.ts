/**
 * Errors the API turns into responses (app.ts). Each has a status and a
 * stable `code` clients can branch on; anything else is a 500.
 */
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 503,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(400, "INVALID_REQUEST", message, details);
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string) {
    super(404, "NOT_FOUND", message);
  }
}

export class ConflictError extends HttpError {
  constructor(message: string, code: "CONFLICT" | "SEQ_CONFLICT" = "CONFLICT", details?: unknown) {
    super(409, code, message, details);
  }
}

export class ForbiddenError extends HttpError {
  constructor(message: string) {
    super(403, "FORBIDDEN", message);
  }
}

export class PayloadTooLargeError extends HttpError {
  constructor(message: string) {
    super(413, "PAYLOAD_TOO_LARGE", message);
  }
}

/**
 * Reads a body stream, failing with PayloadTooLargeError past `max` bytes
 * (counted as they arrive, so an oversized or zip-bomb body is never held whole).
 */
export async function readCapped(
  body: ReadableStream<Uint8Array>,
  max: number,
): Promise<Uint8Array<ArrayBuffer>> {
  let seen = 0;
  const counted = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        seen += chunk.byteLength;
        if (seen > max) ctl.error(new PayloadTooLargeError(`body is over ${max} bytes`));
        else ctl.enqueue(chunk);
      },
    }),
  );
  try {
    return new Uint8Array(await new Response(counted).arrayBuffer());
  } catch (e) {
    if (seen > max) throw new PayloadTooLargeError(`body is over ${max} bytes`);
    throw new BadRequestError(`could not read the body: ${(e as Error).message}`);
  }
}
