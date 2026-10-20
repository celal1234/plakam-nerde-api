import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateMeDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @MinLength(2) @MaxLength(40)
  displayName?: string;
}

export class NotificationPrefsDto {
  @IsOptional() @IsBoolean() newMessage?: boolean;
  @IsOptional() @IsBoolean() expiry?: boolean;
  @IsOptional() @IsBoolean() plateAlert?: boolean;
}
