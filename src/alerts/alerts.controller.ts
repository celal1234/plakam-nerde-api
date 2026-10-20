import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { AuthUser, CurrentUser, RequireVerifiedEmail } from '../auth/auth.decorators';
import { CreateAlertDto, PlateAlert } from './alerts.dto';
import { AlertsService } from './alerts.service';

@Controller('me/alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser): Promise<PlateAlert[]> {
    return this.alerts.list(user.id);
  }

  // Bildirim e-postayla gittiği için doğrulanmış adres gerekir.
  @Post()
  @RequireVerifiedEmail()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateAlertDto): Promise<PlateAlert> {
    return this.alerts.create(user.id, dto.plate);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.alerts.remove(user.id, id);
  }
}
