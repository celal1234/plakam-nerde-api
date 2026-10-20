import * as Joi from 'joi';

// Uygulama açılırken eksik veya hatalı ortam değişkeni varsa hemen durur.
export const envSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'staging', 'production').default('development'),
  PORT: Joi.number().port().default(3000),
  DATABASE_URL: Joi.string().uri({ scheme: ['postgres', 'postgresql'] }).required(),
  DATABASE_SSL: Joi.boolean().default(false),
  REDIS_URL: Joi.string().uri({ scheme: ['redis', 'rediss'] }).required(),
  CORS_ORIGINS: Joi.string().allow('').default(''),
  RUN_MIGRATIONS: Joi.boolean().default(true),
});
