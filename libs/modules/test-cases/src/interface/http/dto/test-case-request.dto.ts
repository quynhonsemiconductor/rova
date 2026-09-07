import { createZodDto } from 'nestjs-zod';
import { PageQuerySchema } from '@platform';

// No filters in Phase A — the tab loads one Work Item's Test Cases whole, in rank order (AC2).
export const TestCaseListQuerySchema = PageQuerySchema;

export class TestCaseListQueryDto extends createZodDto(TestCaseListQuerySchema) {}
