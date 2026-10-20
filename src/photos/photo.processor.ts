import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, UnrecoverableError, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import sharp from 'sharp';
import { DataSource } from 'typeorm';
import { PHOTO_QUEUE, PhotoJob, QUEUE_CONNECTION } from '../queue/queue.module';
import { StorageService } from '../storage/storage.service';

const MAX_BYTES = 10 * 1024 * 1024;
const FULL_PX = 1600;
const THUMB_PX = 400;

// NFR-011 / AC-19: yüklenen dosya gerçekten JPEG/PNG mi kontrol edilir, yeniden kodlanır (EXIF dahil tüm
// meta veri düşer), küçük resim üretilir ve orijinal silinir. Sonuç her zaman JPEG'dir.
@Injectable()
export class PhotoProcessor implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('PhotoProcessor');
  private worker?: Worker<PhotoJob>;

  constructor(
    private readonly db: DataSource,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
    @Inject(QUEUE_CONNECTION) private readonly connection: Redis,
  ) {}

  onModuleInit() {
    if (this.config.get('WORKER_ENABLED') !== true) return;
    this.worker = new Worker<PhotoJob>(PHOTO_QUEUE, (job) => this.process(job), {
      connection: this.connection.duplicate(),
      concurrency: 2,
    });
    this.worker.on('failed', (job, err) => {
      this.logger.warn(`photo ${job?.data.photoId} deneme ${job?.attemptsMade}: ${err.message}`);
    });
  }

  async onApplicationShutdown() {
    await this.worker?.close();
  }

  async process(job: Pick<Job<PhotoJob>, 'data'>): Promise<void> {
    const { photoId } = job.data;
    const [photo]: { storage_key: string; thumb_key: string | null }[] = await this.db.query(
      `SELECT storage_key, thumb_key FROM photos WHERE id = $1`,
      [photoId],
    );
    if (!photo || photo.thumb_key) return; // silinmiş ya da zaten işlenmiş

    // Nesne henüz yoksa hata fırlatılır ve iş geri çekilerek tekrar denenir.
    const original = await this.storage.get(photo.storage_key);

    let full: Buffer;
    let thumb: Buffer;
    try {
      if (original.length > MAX_BYTES) throw new Error('too large');
      const { format } = await sharp(original).metadata();
      if (format !== 'jpeg' && format !== 'png') throw new Error(`unsupported format ${format}`);
      // rotate(): EXIF yönünü piksellere uygular; sharp çıktıya meta veri yazmaz.
      full = await sharp(original).rotate().resize(FULL_PX, FULL_PX, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
      thumb = await sharp(original).rotate().resize(THUMB_PX, THUMB_PX, { fit: 'cover' }).jpeg({ quality: 75, mozjpeg: true }).toBuffer();
    } catch (e) {
      await this.reject(photoId, photo.storage_key, (e as Error).message);
      throw new UnrecoverableError(`invalid image: ${(e as Error).message}`);
    }

    const fullKey = `photos/${photoId}.jpg`;
    const thumbKey = `thumbs/${photoId}.jpg`;
    await this.storage.put(fullKey, full, 'image/jpeg');
    await this.storage.put(thumbKey, thumb, 'image/jpeg');
    await this.db.query(
      `UPDATE photos SET storage_key = $2, thumb_key = $3, mime = 'image/jpeg', bytes = $4 WHERE id = $1`,
      [photoId, fullKey, thumbKey, full.length],
    );
    await this.storage.delete(photo.storage_key);
  }

  // Resim olmayan ya da çözülemeyen dosya: nesne ve kayıt silinir, olay denetim kaydına yazılır.
  private async reject(photoId: string, key: string, reason: string): Promise<void> {
    await this.storage.delete(key).catch(() => undefined);
    await this.db.transaction(async (tx) => {
      await tx.query(`DELETE FROM photos WHERE id = $1`, [photoId]);
      await tx.query(
        `INSERT INTO audit_log (action, target_type, target_id, meta) VALUES ('photo.rejected', 'photo', $1, $2)`,
        [photoId, JSON.stringify({ reason })],
      );
    });
  }
}
