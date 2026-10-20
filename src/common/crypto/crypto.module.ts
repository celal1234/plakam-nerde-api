import { Global, Module } from '@nestjs/common';
import { DataCipher } from './data-cipher';

@Global()
@Module({ providers: [DataCipher], exports: [DataCipher] })
export class CryptoModule {}
