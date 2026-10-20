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
