import { Transform, Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const LISTING_FILTER_STATUSES = ['pending', 'active', 'handed_over', 'closed', 'expired', 'removed', 'hidden'] as const;
export const RESTRICT_DAYS = [1, 7, 30] as const;

export class MfaCodeDto {
  @Matches(/^\d{6}$/) code: string;
}

export class PageDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset = 0;
}

export class AdminListingsQueryDto extends PageDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(20) plate?: string;
  @IsOptional() @IsIn(LISTING_FILTER_STATUSES) status?: (typeof LISTING_FILTER_STATUSES)[number];
  @IsOptional() @Transform(trim) @IsString() @MaxLength(40) city?: string;
  // İlanın oluşturulma günü (İstanbul saatiyle), iki uç dahil.
  @IsOptional() @IsDateString({ strict: true }) from?: string;
  @IsOptional() @IsDateString({ strict: true }) to?: string;
}

export class ReasonDto {
  // İlan sahibine e-postayla iletilir (FR-046).
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(500) reason: string;
}

export class AdminReportsQueryDto extends PageDto {
  @IsOptional() @IsIn(['open', 'resolved_action', 'resolved_no_action']) status: 'open' | 'resolved_action' | 'resolved_no_action' =
    'open';
}

// `days: null` süresiz kısıtlamadır; alan hiç gönderilmezse de süresiz sayılmaz, doğrulama hatası döner.
export class RestrictDto {
  @ValidateIf((_, v) => v !== null) @IsIn(RESTRICT_DAYS) days: (typeof RESTRICT_DAYS)[number] | null;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) note?: string;
}

export class ResolveReportDto {
  @IsIn(['none', 'remove_listing', 'restrict_user']) action: 'none' | 'remove_listing' | 'restrict_user';
  @ValidateIf((o: ResolveReportDto, v) => o.action === 'restrict_user' && v !== null) @IsIn(RESTRICT_DAYS) days?:
    | (typeof RESTRICT_DAYS)[number]
    | null;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) note?: string;
}

export class MetricsQueryDto {
  @IsOptional() @IsDateString({ strict: true }) from?: string;
  @IsOptional() @IsDateString({ strict: true }) to?: string;
}
