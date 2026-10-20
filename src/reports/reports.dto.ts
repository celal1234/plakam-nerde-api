import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const REPORT_REASONS = ['fake', 'wrong_plate', 'inappropriate_photo', 'personal_data', 'harassment', 'spam', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const REPORT_STATUSES = ['open', 'resolved_action', 'resolved_no_action'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

// FR-071: ilan, kullanıcı veya konuşma şikâyet edilebilir; tam olarak biri verilir.
export class CreateReportDto {
  @IsOptional() @IsUUID() listingId?: string;
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsUUID() conversationId?: string;
  @IsIn(REPORT_REASONS) reason: ReportReason;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) note?: string;
}

export class CreatedReport {
  id: string;
  status: 'open';
  createdAt: Date;
}
