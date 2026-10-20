import { Transform, Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { LatLng, UserRef } from '../common/dto/shared.dto';
import type { ListingStatus } from '../listings/listings.dto';
import { REPORT_STATUSES, type ReportReason, type ReportStatus } from '../reports/reports.dto';
import type { UserStatus } from '../users/users.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const LISTING_FILTER_STATUSES = ['pending', 'active', 'handed_over', 'closed', 'expired', 'removed', 'hidden'] as const;
export const RESTRICT_DAYS = [1, 7, 30] as const;

export class MfaCodeDto {
  @Matches(/^\d{6}$/) code: string;
}

export class PageDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number = 50;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number = 0;
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
  @IsOptional() @IsIn(REPORT_STATUSES) status?: ReportStatus = 'open';
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

// ---- Yanıtlar ----

export class MfaSetup {
  // Base32; QR okutulamazsa elle girilir.
  secret: string;
  otpauthUrl: string;
  expiresInSec: number;
}

export class AdminUserRef extends UserRef {
  status: UserStatus;
}

export class AdminListing {
  id: string;
  plateDisplay: string;
  plateNormalized: string;
  status: ListingStatus;
  hiddenByReports: boolean;
  isOfficialPlate: boolean;
  plateFormatOk: boolean;
  city: string;
  district: string | null;
  // YYYY-MM-DD
  foundAt: string;
  createdAt: Date;
  expiresAt: Date;
  handoverConfirmed: boolean | null;
  // Farklı kullanıcılardan gelen açık şikâyet sayısı.
  openReports: number;
  approxCenter: LatLng;
  owner: AdminUserRef;
  thumbUrl: string | null;
}

export class AdminListingPage {
  total: number;
  items: AdminListing[];
}

export class AdminListingReport {
  id: string;
  reason: ReportReason;
  note: string | null;
  status: ReportStatus;
  createdAt: Date;
  reporter: UserRef;
}

export class AdminListingDetail extends AdminListing {
  photoUrls: string[];
  reports: AdminListingReport[];
}

export class AdminListingStatus {
  id: string;
  status: ListingStatus;
}

export class AdminReportListing {
  id: string;
  plateDisplay: string;
  status: ListingStatus;
  hiddenByReports: boolean;
  openReports: number;
}

export class AdminReportUser extends AdminUserRef {
  restrictedUntil: string | null;
}

export class AdminReport {
  id: string;
  reason: ReportReason;
  note: string | null;
  status: ReportStatus;
  createdAt: Date;
  resolvedAt: Date | null;
  reporter: UserRef;
  // Şikâyetin hedefine göre `listing`, `targetUser` ve `conversationId`'den biri veya ikisi dolu olur.
  listing: AdminReportListing | null;
  targetUser: AdminReportUser | null;
  conversationId: string | null;
}

export class AdminReportPage {
  total: number;
  items: AdminReport[];
}

export class ResolvedReport {
  id: string;
  status: 'resolved_action' | 'resolved_no_action';
}

export class UserRestriction {
  id: string;
  status: 'restricted' | 'active';
  // null: süresiz kısıtlama veya kısıtlama yok.
  restrictedUntil: Date | null;
}

export class AdminPhone {
  phone: string | null;
}

export class MetricTotals {
  newListings: number;
  searches: number;
  searchesWithResult: number;
  // 0–1 arası, üç ondalık; arama yoksa null.
  matchRate: number | null;
  handovers: number;
}

export class MetricsDay {
  // YYYY-MM-DD (İstanbul günü)
  day: string;
  newListings: number;
  searches: number;
  searchesWithResult: number;
  matchRate: number | null;
  handovers: number;
}

export class Metrics {
  from: string | null;
  to: string | null;
  totals: MetricTotals;
  days: MetricsDay[];
}
