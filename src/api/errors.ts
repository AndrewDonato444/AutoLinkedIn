export class GojiBerryError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = 'GojiBerryError';
  }
}

export class ConfigError extends GojiBerryError {
  constructor() {
    super(
      'Missing GOJIBERRY_API_KEY in .env.local — grab your API key from GojiBerry settings',
    );
    this.name = 'ConfigError';
  }
}

export class AuthError extends GojiBerryError {
  constructor() {
    super(
      'GojiBerry API key is invalid or expired — check GOJIBERRY_API_KEY in .env.local',
      401,
    );
    this.name = 'AuthError';
  }
}

export class NotFoundError extends GojiBerryError {
  constructor(resource: string, id: string) {
    super(`${resource} ${id} not found in GojiBerry`, 404);
    this.name = 'NotFoundError';
  }
}

export class TimeoutError extends GojiBerryError {
  constructor() {
    super('Request timed out — GojiBerry may be slow, try again');
    this.name = 'TimeoutError';
  }
}

export class ServerError extends GojiBerryError {
  constructor() {
    super('GojiBerry API is down — try again in a few minutes');
    this.name = 'ServerError';
  }
}

export class ValidationError extends GojiBerryError {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Internal: thrown by request() on 404, wrapped by callers with proper resource name */
export class Http404Error extends Error {
  readonly httpStatus = 404;
  constructor(path: string) {
    super(`404: ${path}`);
    this.name = 'Http404Error';
  }
}
