import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ApiError } from '../common/errors/api-error';

// Kova herkese kapalıdır; istemci yalnızca kısa ömürlü imzalı adreslerle okur ve yazar (T6 §5).
@Injectable()
export class StorageService {
  private readonly client?: S3Client;
  private readonly bucket: string;

  constructor(config: ConfigService) {
    this.bucket = config.getOrThrow<string>('S3_BUCKET');
    const endpoint = config.get<string>('S3_ENDPOINT');
    const accessKeyId = config.get<string>('S3_ACCESS_KEY');
    const secretAccessKey = config.get<string>('S3_SECRET_KEY');
    if (endpoint && accessKeyId && secretAccessKey) {
      this.client = new S3Client({
        endpoint,
        region: config.getOrThrow<string>('S3_REGION'),
        credentials: { accessKeyId, secretAccessKey },
        forcePathStyle: true,
      });
    }
  }

  async presignPut(key: string, mime: string, bytes: number, expiresIn = 300): Promise<string> {
    const command = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: mime, ContentLength: bytes });
    return getSignedUrl(this.s3(), command, { expiresIn });
  }

  async presignGet(key: string, expiresIn = 900): Promise<string> {
    return getSignedUrl(this.s3(), new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn });
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.s3().send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.s3().send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async delete(key: string): Promise<void> {
    await this.s3().send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  private s3(): S3Client {
    if (!this.client) {
      throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'STORAGE_UNAVAILABLE', 'Fotoğraf yükleme şu an kullanılamıyor.');
    }
    return this.client;
  }
}
