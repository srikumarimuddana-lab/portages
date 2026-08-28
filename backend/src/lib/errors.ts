/**
 * Error taxonomy.
 *
 * The rule this file exists to enforce: internal detail never reaches a
 * client. AppError instances carry a safe, deliberate message; anything else
 * becomes a generic 500 with a correlation id, and the real error goes to the
 * log only.
 */

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: string[];

  constructor(status: number, code: string, message: string, details?: string[]) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

export const badRequest = (msg: string, details?: string[]) => new AppError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'Authentication required.') => new AppError(401, 'unauthorized', msg);
export const forbidden = (msg = 'You do not have access to this resource.') => new AppError(403, 'forbidden', msg);
export const notFound = (msg = 'Not found.') => new AppError(404, 'not_found', msg);
export const conflict = (msg: string) => new AppError(409, 'conflict', msg);
export const payloadTooLarge = (msg = 'Request body is too large.') => new AppError(413, 'payload_too_large', msg);
export const tooManyRequests = (msg = 'Too many requests. Try again shortly.') =>
  new AppError(429, 'rate_limited', msg);

export interface ClientError {
  error: { code: string; message: string; details?: string[]; requestId: string };
}

/**
 * Converts any thrown value into a client-safe response body.
 * Unknown errors deliberately lose their message.
 */
export function toClientError(err: unknown, requestId: string): { status: number; body: ClientError } {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
          requestId,
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: 'internal_error',
        message: 'Something went wrong on our end.',
        requestId,
      },
    },
  };
}
