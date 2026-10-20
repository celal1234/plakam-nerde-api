import { IsIn, IsInt, Max, Min } from 'class-validator';

// HEIC kabul edilmez: sunucudaki görüntü kütüphanesi HEVC çözemiyor. Mobil uygulama iOS fotoğraflarını
// yüklemeden önce JPEG'e çevirir.
export const PHOTO_MIMES = ['image/jpeg', 'image/png'] as const;

export class UploadUrlDto {
  @IsIn(PHOTO_MIMES as unknown as string[]) mime: (typeof PHOTO_MIMES)[number];
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) bytes: number;
}

export class UploadUrl {
  photoId: string;
  // 5 dakika geçerli imzalı PUT adresi; `Content-Type` ve `Content-Length` istekteki değerlerle aynı olmalı.
  putUrl: string;
}
