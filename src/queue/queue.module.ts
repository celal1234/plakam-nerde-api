import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export const PHOTO_QUEUE = 'photos';
export const PHOTOS = Symbol('PHOTOS_QUEUE');
export const QUEUE_CONNECTION = Symbol('QUEUE_CONNECTION');

export interface PhotoJob {
  photoId: string;
}

@Injectable()
class QueueCloser implements OnApplicationShutdown {
  constructor(
    @Inject(PHOTOS) private readonly photos: Queue<PhotoJob>,
    @Inject(QUEUE_CONNECTION) private readonly connection: Redis,
  ) {}
  async onApplicationShutdown() {
    await this.photos.close();
    await this.connection.quit();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: QUEUE_CONNECTION,
      inject: [ConfigService],
      // BullMQ engelleyici komutlar kullanır; ayrı bağlantı ve `maxRetriesPerRequest: null` ister.
      useFactory: (config: ConfigService) =>
        new Redis(config.getOrThrow<string>('REDIS_URL'), { maxRetriesPerRequest: null }),
    },
    {
      provide: PHOTOS,
      inject: [QUEUE_CONNECTION],
      useFactory: (connection: Redis) =>
        new Queue<PhotoJob>(PHOTO_QUEUE, {
          connection,
          defaultJobOptions: {
            attempts: 5,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: 1000,
            removeOnFail: 5000,
          },
        }),
    },
    QueueCloser,
  ],
  exports: [PHOTOS, QUEUE_CONNECTION],
})
export class QueueModule {}
