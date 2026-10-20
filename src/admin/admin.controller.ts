import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AdminOnly, AuthUser, CurrentUser } from '../auth/auth.decorators';
import {
  AdminListingsQueryDto,
  AdminReportsQueryDto,
  MetricsQueryDto,
  MfaCodeDto,
  ReasonDto,
  ResolveReportDto,
  RestrictDto,
} from './admin.dto';
import { AdminService } from './admin.service';

const uuid = new ParseUUIDPipe();

// MFA kurulumu ve doğrulaması: yönetici rolü yeterli, henüz MFA'lı oturum gerekmez.
@Controller('admin/mfa')
@AdminOnly({ mfa: false })
export class AdminMfaController {
  constructor(private readonly admin: AdminService) {}

  @Post('setup')
  @HttpCode(HttpStatus.OK)
  setup(@CurrentUser() user: AuthUser) {
    return this.admin.mfaSetup(user);
  }

  // Başarılı doğrulama MFA işaretli yeni bir token çifti döndürür; panel eski refresh token'ı bırakır.
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  verify(@CurrentUser() user: AuthUser, @Body() dto: MfaCodeDto, @Ip() ip: string) {
    return this.admin.mfaVerify(user, dto.code, ip);
  }
}

@Controller('admin')
@AdminOnly()
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('listings')
  listings(@Query() q: AdminListingsQueryDto) {
    return this.admin.listings(q);
  }

  @Get('listings/:id')
  listing(@Param('id', uuid) id: string) {
    return this.admin.listingDetail(id);
  }

  @Post('listings/:id/approve')
  @HttpCode(HttpStatus.OK)
  approve(@CurrentUser() user: AuthUser, @Ip() ip: string, @Param('id', uuid) id: string) {
    return this.admin.approve({ user, ip }, id);
  }

  @Post('listings/:id/reject')
  @HttpCode(HttpStatus.OK)
  reject(@CurrentUser() user: AuthUser, @Ip() ip: string, @Param('id', uuid) id: string, @Body() dto: ReasonDto) {
    return this.admin.reject({ user, ip }, id, dto.reason);
  }

  @Post('listings/:id/remove')
  @HttpCode(HttpStatus.OK)
  remove(@CurrentUser() user: AuthUser, @Ip() ip: string, @Param('id', uuid) id: string, @Body() dto: ReasonDto) {
    return this.admin.remove({ user, ip }, id, dto.reason);
  }

  @Get('listings/:id/exact-location')
  exactLocation(@CurrentUser() user: AuthUser, @Ip() ip: string, @Param('id', uuid) id: string) {
    return this.admin.exactLocation({ user, ip }, id);
  }

  @Get('reports')
  reports(@Query() q: AdminReportsQueryDto) {
    return this.admin.reports(q);
  }

  @Post('reports/:id/resolve')
  @HttpCode(HttpStatus.OK)
  resolve(@CurrentUser() user: AuthUser, @Ip() ip: string, @Param('id', uuid) id: string, @Body() dto: ResolveReportDto) {
    return this.admin.resolveReport({ user, ip }, id, dto);
  }

  @Post('users/:id/restrict')
  @HttpCode(HttpStatus.OK)
  restrict(@CurrentUser() user: AuthUser, @Ip() ip: string, @Param('id', uuid) id: string, @Body() dto: RestrictDto) {
    return this.admin.restrict({ user, ip }, id, dto.days, dto.note);
  }

  @Post('users/:id/unrestrict')
  @HttpCode(HttpStatus.OK)
  unrestrict(@CurrentUser() user: AuthUser, @Ip() ip: string, @Param('id', uuid) id: string) {
    return this.admin.unrestrict({ user, ip }, id);
  }

  @Get('users/:id/phone')
  phone(@CurrentUser() user: AuthUser, @Ip() ip: string, @Param('id', uuid) id: string) {
    return this.admin.phone({ user, ip }, id);
  }

  @Get('metrics')
  metrics(@Query() q: MetricsQueryDto) {
    return this.admin.metrics(q.from, q.to);
  }
}
