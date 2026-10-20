import { Global, Module } from '@nestjs/common';
import { AlertsController } from './alerts.controller';
import { AlertsProcessor } from './alerts.processor';
import { AlertsService } from './alerts.service';

// İlan ve yönetici modülleri ilan yayına girince `AlertsService.listingPublished` çağırır.
@Global()
@Module({ controllers: [AlertsController], providers: [AlertsService, AlertsProcessor], exports: [AlertsService] })
export class AlertsModule {}
