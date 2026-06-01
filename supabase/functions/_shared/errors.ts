import { logger } from './logger.ts'
import type { LoggerLike } from './logger.ts'

export type AppErrorCode =
  | 'VALIDATION_ERROR'
  | 'ACCESS_DENIED'
  | 'RESOURCE_NOT_FOUND'
  | 'UNPROCESSABLE_ENTITY'
  | 'INTERNAL_SERVICE_ERROR'
  | 'AI_ERROR'

type AppExceptionOptions = {
  message?: string
  sourceError?: Error | null
}

export class AppException extends Error {
  readonly code: AppErrorCode
  readonly status: number
  readonly sourceError?: Error | null

  constructor(
    name: string,
    code: AppErrorCode,
    status: number,
    options: AppExceptionOptions = {},
  ) {
    super(options.message)
    this.name = name
    this.code = code
    this.status = status
    this.sourceError = options.sourceError
  }
}

export class AccessDeniedException extends AppException {
  constructor(options: AppExceptionOptions = {}) {
    super('AccessDeniedException', 'ACCESS_DENIED', 401, {
      message: options.message ?? 'Unauthorized',
      sourceError: options.sourceError,
    })
  }
}

export class ValidationException extends AppException {
  constructor(options: AppExceptionOptions = {}) {
    super('ValidationException', 'VALIDATION_ERROR', 400, {
      message: options.message ?? 'Invalid request',
      sourceError: options.sourceError,
    })
  }
}

export class UnprocessableEntityException extends AppException {
  constructor(options: AppExceptionOptions = {}) {
    super('UnprocessableEntityException', 'UNPROCESSABLE_ENTITY', 422, {
      message: options.message ?? 'Could not process request',
      sourceError: options.sourceError,
    })
  }
}

export class ResourceNotFoundException extends AppException {
  constructor(options: AppExceptionOptions = {}) {
    super('ResourceNotFoundException', 'RESOURCE_NOT_FOUND', 404, {
      message: options.message ?? 'Not found',
      sourceError: options.sourceError,
    })
  }
}

export class InternalServiceException extends AppException {
  constructor(options: AppExceptionOptions = {}) {
    super('InternalServiceException', 'INTERNAL_SERVICE_ERROR', 500, {
      message: options.message ?? 'Internal error',
      sourceError: options.sourceError,
    })
  }
}

export class AiException extends AppException {
  constructor(options: AppExceptionOptions = {}) {
    super('AiException', 'AI_ERROR', 500, {
      message: options.message ?? 'AI request failed',
      sourceError: options.sourceError,
    })
  }
}

export function normalizeError(error: Error | AppException): AppException {
  if (error instanceof AppException) return error
  const status = (error as { status?: number }).status
  const message = error.message || 'Internal error'

  if (status === 401 || status === 403) return new AccessDeniedException({ message })
  if (status === 400) return new ValidationException({ message })
  if (status === 404) return new ResourceNotFoundException({ message })
  if (status === 422) return new UnprocessableEntityException({ message })
  return new InternalServiceException({ message })
}

export function errorBody(
  error: AppException | Error,
): { error: { code: AppErrorCode; message: string } } {
  const normalized = normalizeError(error)
  return { error: { code: normalized.code, message: normalized.message ?? 'Internal error' } }
}

export function logError(
  error: AppException | Error,
  message: string,
  extra: Record<string, string> = {},
  log: LoggerLike = logger,
): AppException {
  const normalized = normalizeError(error)
  log.error(
    {
      ...extra,
      code: normalized.code,
      status: normalized.status,
      sourceError: normalized.sourceError,
    },
    message,
  )
  return normalized
}
