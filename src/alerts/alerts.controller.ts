import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { AuthUser, CurrentUser, RequireVerifiedEmail } from '../auth/auth.decorators';
import { AlertsService } from './alerts.service';

export class CreateAlertDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @IsNotEmpty() @MaxLength(20)
  plate: string;
}

@Controller('me/alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.alerts.list(user.id);
  }

  // Bildirim e-postayla gittiği için doğrulanmış adres gerekir.
  @Post()
  @RequireVerifiedEmail()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateAlertDto) {
    return this.alerts.create(user.id, dto.plate);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.alerts.remove(user.id, id);
  }
}
