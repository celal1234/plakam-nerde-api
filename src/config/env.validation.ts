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
  JWT_SECRET: Joi.string().min(32).required(),
  // E-postadaki bağlantıların açılacağı adres; mobil uygulama bu alan adını App Link / Universal Link olarak yakalar.
  APP_URL: Joi.string().uri({ scheme: ['https', 'http'] }).default('http://localhost:3000'),
  SMTP_URL: Joi.string().uri({ scheme: ['smtp', 'smtps'] }).allow('').optional(),
  // S3 uyumlu depolama (Garage / MinIO / herhangi bir S3). Tanımlı değilse fotoğraf uçları 503 döner.
  S3_ENDPOINT: Joi.string().uri().allow('').optional(),
  S3_REGION: Joi.string().default('garage'),
  S3_BUCKET: Joi.string().default('plakam-photos'),
  S3_ACCESS_KEY: Joi.string().allow('').optional(),
  S3_SECRET_KEY: Joi.string().allow('').optional(),
  MAIL_FROM: Joi.string().default('Plakam Nerde? <no-reply@localhost>'),
});
