import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

const trimLower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class RegisterDto {
  @Transform(trimLower) @IsEmail() @MaxLength(254) email: string;
  // T6 §5: en az 10 karakter; argon2 için makul üst sınır.
  @IsString() @MinLength(10) @MaxLength(128) password: string;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(40) displayName: string;
  @IsString() @IsNotEmpty() @MaxLength(20) termsVersion: string;
}

export class LoginDto {
  @Transform(trimLower) @IsEmail() email: string;
  @IsString() @IsNotEmpty() @MaxLength(128) password: string;
}

export class TokenDto {
  @IsString() @IsNotEmpty() @MaxLength(200) token: string;
}

export class RefreshDto {
  @IsString() @IsNotEmpty() @MaxLength(200) refreshToken: string;
}

export class ForgotPasswordDto {
  @Transform(trimLower) @IsEmail() email: string;
}

export class ResetPasswordDto {
  @IsString() @IsNotEmpty() @MaxLength(200) token: string;
  @IsString() @MinLength(10) @MaxLength(128) password: string;
}
