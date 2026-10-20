import { Body, Controller, Post } from '@nestjs/common';
import { AuthUser, CurrentUser, RequireVerifiedEmail } from '../auth/auth.decorators';
import { CreateReportDto } from './reports.dto';
import { ReportsService } from './reports.service';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post()
  @RequireVerifiedEmail()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateReportDto) {
    return this.reports.create(user, dto);
  }
}
