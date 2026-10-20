import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUE_CONNECTION } from '../queue/queue.module';
import { MaintenanceService } from './maintenance.service';

const QUEUE = 'maintenance';
const TZ = 'Europe/Istanbul';

// Zamanlamalar Redis'te tutulur; birden fazla API kopyası aynı işi bir kez çalıştırır.
const SCHEDULES: { name: string; pattern: string }[] = [
  { name: 'expire-listings', pattern: '5 * * * *' }, // saatlik
  { name: 'expiry-reminders', pattern: '0 9 * * *' }, // her gün 09:00
  { name: 'retention-purge', pattern: '0 3 * * *' }, // her gün 03:00
  { name: 'orphan-photos', pattern: '30 3 * * *' }, // her gün 03:30
];

@Injectable()
export class MaintenanceScheduler implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('MaintenanceScheduler');
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly maintenance: MaintenanceService,
    private readonly config: ConfigService,
    @Inject(QUEUE_CONNECTION) private readonly connection: Redis,
  ) {}

  async onModuleInit() {
    if (this.config.get('WORKER_ENABLED') !== true) return;
    this.queue = new Queue(QUEUE, { connection: this.connection });
    for (const s of SCHEDULES) {
      await this.queue.upsertJobScheduler(
        s.name,
        { pattern: s.pattern, tz: TZ },
        { name: s.name, opts: { removeOnComplete: 50, removeOnFail: 200 } },
      );
    }
    this.worker = new Worker(QUEUE, (job) => this.run(job.name), { connection: this.connection.duplicate() });
    this.worker.on('failed', (job, err) => this.logger.error(`${job?.name}: ${err.message}`));
  }

  async onApplicationShutdown() {
    await this.worker?.close();
    await this.queue?.close();
  }

  async run(name: string): Promise<unknown> {
    const jobs: Record<string, () => Promise<unknown>> = {
      'expire-listings': () => this.maintenance.expireListings(),
      'expiry-reminders': () => this.maintenance.sendExpiryReminders(),
      'retention-purge': () => this.maintenance.purgeRetention(),
      'orphan-photos': () => this.maintenance.purgeOrphanPhotos(),
    };
    const result = await jobs[name]?.();
    this.logger.log(`${name}: ${JSON.stringify(result)}`);
    return result;
  }
}
