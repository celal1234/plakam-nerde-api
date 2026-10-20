import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateAlertDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @IsNotEmpty() @MaxLength(20)
  plate: string;
}

export class PlateAlert {
  id: string;
  // Normalize edilmiş plaka (boşluksuz, büyük harf).
  plate: string;
  expiresAt: Date;
  createdAt: Date;
}
