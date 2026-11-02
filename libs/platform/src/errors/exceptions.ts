import { DomainException as SharedDomainException } from '@quynhonsemiconductor/platform-http';
import type { ErrorCategory, ErrorCode } from './error-codes';

/**
 * Base exception for all domain/application errors.
 * The global exception filter maps this to the wire envelope.
 * Domain functions return Result<T,E>; they throw DomainException only at
 * use-case boundaries after losing the ability to continue.
 *
 * Extends the shared `@quynhonsemiconductor/platform-http` DomainException so that errors
 * thrown by shared packages (e.g. @quynhonsemiconductor/identity's AuthService) and errors
 * thrown by rova's own use-cases share ONE class identity. The global
 * exception filter maps both through a single `instanceof` branch instead of
 * letting shared-package errors fall through to a generic 500. Rova keeps its
 * strict `ErrorCode` catalog typing on the constructor (the shared base
 * intentionally accepts an open `string`); the shared base derives `httpStatus`
 * from the (identical) category table.
 */
export class DomainException extends SharedDomainException {
  constructor(code: ErrorCode, message: string, category: ErrorCategory, details?: unknown[]) {
    super(code, message, category, details);
  }
}

export class NotFoundException extends DomainException {
  constructor(code: ErrorCode, message: string) {
    super(code, message, 'NOT_FOUND');
  }
}

export class ConflictException extends DomainException {
  constructor(code: ErrorCode, message: string) {
    super(code, message, 'CONFLICT');
  }
}

export class PermissionDeniedException extends DomainException {
  constructor(codeOrMessage: string = 'PERMISSION_DENIED', message?: string) {
    // Support both: new PermissionDeniedException('PROJECT_PERMISSION_DENIED', 'msg')
    // and legacy: new PermissionDeniedException('msg')
    const isCode = message !== undefined;
    super(
      isCode ? (codeOrMessage as ErrorCode) : 'PERMISSION_DENIED',
      isCode ? message : codeOrMessage,
      'PERMISSION_DENIED',
    );
  }
}

export class UnauthorizedException extends DomainException {
  constructor(code: ErrorCode, message: string) {
    super(code, message, 'UNAUTHORIZED');
  }
}

export class PreconditionFailedException extends DomainException {
  constructor(code: ErrorCode, message: string) {
    super(code, message, 'PRECONDITION_FAILED');
  }
}

/**
 * Application-level input validation failures raised outside the Zod DTO
 * pipeline (e.g. business-rule checks in a service method). Maps to HTTP 422,
 * same as ZodValidationException, so the FE can treat every `VALIDATION_FAILED`
 * code consistently regardless of where it was thrown.
 */
export class ValidationException extends DomainException {
  constructor(code: ErrorCode, message: string) {
    super(code, message, 'VALIDATION_FAILED');
  }
}

export class RateLimitedException extends DomainException {
  constructor(message = 'Rate limit exceeded') {
    super('RATE_LIMITED', message, 'RATE_LIMITED');
  }
}
