import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { LatLng } from '../common/dto/shared.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class LocationDto {
  @IsLatitude() lat: number;
  @IsLongitude() lng: number;
  @IsIn(['gps', 'map']) source: 'gps' | 'map';
}

export class CreateListingDto {
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(20) plate: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(3) @ArrayUnique() @IsUUID('4', { each: true }) photoIds: string[];
  @ValidateNested() @Type(() => LocationDto) location: LocationDto;
  // İl/ilçe istemcide haritadan (ters geokodlama) gelir; sunucu ayrıca coğrafi kodlama yapmaz.
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(40) city: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(60) district?: string;
  @IsDateString({ strict: true }) foundAt: string;
  @IsBoolean() isOfficialPlate: boolean;
  @IsBoolean() showPhone: boolean;
}

export class CheckDuplicateDto {
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(20) plate: string;
  @ValidateNested() @Type(() => LocationDto) location: LocationDto;
}

export class UpdateListingDto {
  @IsOptional() @IsBoolean() showPhone?: boolean;
  @IsOptional() @IsDateString({ strict: true }) foundAt?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(60) district?: string;
}

export class CloseListingDto {
  @IsIn(['handed_over_elsewhere', 'given_to_police', 'mistake', 'other']) reason: string;
}

export class HandoverDto {
  @IsOptional() @IsUUID() conversationId?: string;
}

export class SearchQueryDto {
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(20) q: string;
}

export class HandoverConfirmDto {
  @IsBoolean() confirmed: boolean;
}

// ---- Yanıtlar ----

// `expired`, süresi geçmiş ama `expire-listings` işinin henüz işaretlemediği ilanlar için de döner.
export const LISTING_STATUSES = ['pending', 'active', 'handed_over', 'closed', 'expired', 'removed'] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

// Herkese açık kart: kesin konum asla yer almaz (AC-14).
export class ListingCard {
  id: string;
  plateDisplay: string;
  status: ListingStatus;
  // YYYY-MM-DD
  foundAt: string;
  city: string;
  district: string | null;
  // Küçük resim fotoğraf işlenince oluşur; o zamana kadar null.
  thumbUrl: string | null;
  // Kesin noktadan 200–500 m kaydırılmış yaklaşık merkez.
  approxCenter: LatLng;
  approxRadiusM: number;
}

export class ListingOwner {
  displayName: string;
}

export class ListingDetail extends ListingCard {
  expiresAt: Date;
  createdAt: Date;
  isOfficialPlate: boolean;
  plateFormatOk: boolean;
  handoverConfirmed: boolean | null;
  extended: boolean;
  // `PATCH /plates/{id}` için `If-Match` değeri.
  version: number;
  owner: ListingOwner;
  // Numaranın kendisi detayda yok; giriş yapmış kullanıcı `GET /plates/{id}/phone` ile ister (FR-039).
  hasPhone: boolean;
  // Yalnızca işlenmiş (EXIF'i silinmiş) fotoğraflar.
  photoUrls: string[];
}

export class CreatedListing extends ListingDetail {
  warnings: ('PLATE_FORMAT' | 'DUPLICATE_NEARBY')[];
  // 2 km içindeki aynı plakalı aktif ilanlar (BR-009).
  duplicates: ListingCard[];
}

export class OwnListing extends ListingCard {
  expiresAt: Date;
  extended: boolean;
  version: number;
}

export class PlateQuery {
  normalized: string;
}

export class SearchResult {
  query: PlateQuery;
  active: ListingCard[];
  inactive: ListingCard[];
}

export class DuplicateCheck {
  duplicates: ListingCard[];
}

export class ListingVersion {
  id: string;
  version: number;
}

export class ListingStatusChange {
  id: string;
  status: ListingStatus;
  version: number;
}

export class ExtendedListing {
  id: string;
  status: 'active';
  expiresAt: Date;
  version: number;
}

export class HandoverConfirmation {
  id: string;
  handoverConfirmed: boolean;
}

export class PhoneNumber {
  // E.164 biçiminde (+905321234567).
  phone: string;
}
