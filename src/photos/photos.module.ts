import { Module } from '@nestjs/common';
import { PhotoProcessor } from './photo.processor';
import { PhotosController } from './photos.controller';

@Module({ controllers: [PhotosController], providers: [PhotoProcessor] })
export class PhotosModule {}
