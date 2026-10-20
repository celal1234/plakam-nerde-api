import { Body, Controller, HttpStatus, Post } from '@nestjs/common';
import { IsIn, IsInt, Max, Min } from 'class-validator';
import { DataSource } from 'typeorm';
import { AuthUser, CurrentUser, RequireVerifiedEmail } from '../auth/auth.decorators';
import { ApiError } from '../common/errors/api-error';
import { RateLimiter } from '../common/rate-limit/rate-limiter.service';
import { StorageService } from '../storage/storage.service';

export const PHOTO_MIMES = ['image/jpeg', 'image/png', 'image/heic'] as const;
const MAX_BYTES = 10 * 1024 * 1024;

export class UploadUrlDto {
  @IsIn(PHOTO_MIMES as unknown as string[]) mime: string;
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) bytes: number;
}

@Controller('photos')
export class PhotosController {
  constructor(
    private readonly db: DataSource,
    private readonly storage: StorageService,
    private readonly limiter: RateLimiter,
  ) {}

  // Fotoğraf önce ilansız kaydedilir; ilan oluşturulurken `photoIds` ile bağlanır.
  // Sahipsiz kalanları `orphan-photos` işi temizleyecek (BR-014).
  @Post('upload-url')
  @RequireVerifiedEmail()
  async uploadUrl(@CurrentUser() user: AuthUser, @Body() dto: UploadUrlDto) {
    if (dto.bytes > MAX_BYTES) {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'PHOTO_TOO_LARGE', 'Fotoğraf en fazla 10 MB olabilir.');
    }
    await this.limiter.consume(`photo-upload:${user.id}`, 60, 86400);
    const id = crypto.randomUUID();
    const key = `originals/${user.id}/${id}`;
    const putUrl = await this.storage.presignPut(key, dto.mime, dto.bytes);
    await this.db.query(
      `INSERT INTO photos (id, uploader_id, storage_key, mime, bytes, position) VALUES ($1, $2, $3, $4, $5, 1)`,
      [id, user.id, key, dto.mime, dto.bytes],
    );
    return { photoId: id, putUrl };
  }
}
