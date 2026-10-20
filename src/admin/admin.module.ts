import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminController, AdminMfaController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({ imports: [AuthModule], controllers: [AdminMfaController, AdminController], providers: [AdminService] })
export class AdminModule {}
