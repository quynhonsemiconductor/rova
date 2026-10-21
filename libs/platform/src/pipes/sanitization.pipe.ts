import { Injectable, PipeTransform } from '@nestjs/common';
import { sanitizeObject, sanitizeString } from '@quynhonsemiconductor/platform-http';

/**
 * SanitizationPipe — strips XSS-dangerous markup from all string inputs.
 * Applied globally before ZodValidationPipe so values arrive clean.
 *
 * Only touches string/plain-object values; class instances, Buffers,
 * and primitives pass through unchanged.
 */
@Injectable()
export class SanitizationPipe implements PipeTransform {
  transform(value: unknown): unknown {
    if (typeof value === 'string') {
      return sanitizeString(value);
    }
    if (value && typeof value === 'object' && value.constructor === Object) {
      return sanitizeObject(value as Record<string, unknown>);
    }
    return value;
  }
}
