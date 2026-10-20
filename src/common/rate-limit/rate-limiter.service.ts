import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS } from '../../redis/redis.module';
import { ApiError } from '../errors/api-error';

// Sabit pencereli sayaç (T6 §5). Sınır aşılırsa 429 RATE_LIMITED, `Retry-After` ile.
@Injectable()
export class RateLimiter {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async consume(key: string, limit: number, windowSec: number): Promise<void> {
    const redisKey = `rl:${key}`;
    const [[, count], [, ttl]] = (await this.redis
      .multi()
      .incr(redisKey)
      .ttl(redisKey)
      .exec()) as [[null, number], [null, number]];
    if (ttl < 0) await this.redis.expire(redisKey, windowSec);
    if (count > limit) {
      throw new ApiError(
        HttpStatus.TOO_MANY_REQUESTS,
        'RATE_LIMITED',
        'Çok fazla deneme yaptınız, biraz sonra tekrar deneyin.',
        { retryAfter: ttl > 0 ? ttl : windowSec },
      );
    }
  }
}
