import { Transform } from 'class-transformer';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

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

export class PhoneDto {
  @IsString() @IsNotEmpty() @MaxLength(25) phone: string;
}

export type UserStatus = 'active' | 'restricted' | 'banned' | 'deleted';

export class Me {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  role: 'user' | 'admin';
  status: UserStatus;
  phoneLast4: string | null;
  createdAt: Date;
}

export class PhoneLast4 {
  last4: string | null;
}

export class NotificationPrefs {
  newMessage: boolean;
  expiry: boolean;
  plateAlert: boolean;
}

export class DeletedAccount {
  status: 'deleted';
}
