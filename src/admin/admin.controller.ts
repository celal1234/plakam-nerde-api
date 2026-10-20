import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AdminOnly, AuthUser, CurrentUser } from '../auth/auth.decorators';
import { TokenPair } from '../auth/auth.dto';
import { LatLng } from '../common/dto/shared.dto';
import {
  AdminListingDetail,
  AdminListingPage,
  AdminListingsQueryDto,
  AdminListingStatus,
  AdminPhone,
  AdminReportPage,
  AdminReportsQueryDto,
  Metrics,
  MetricsQueryDto,
  MfaCodeDto,
  MfaSetup,
  ReasonDto,
  ResolvedReport,
  ResolveReportDto,
  RestrictDto,
  UserRestriction,
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
  setup(@CurrentUser() user: AuthUser): Promise<MfaSetup> {
    return this.admin.mfaSetup(user);
  }

  // Başarılı doğrulama MFA işaretli yeni bir token çifti döndürür; panel eski refresh token'ı bırakır.
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  verify(@CurrentUser() user: AuthUser, @Body() dto: MfaCodeDto, @Ip() ip: string): Promise<TokenPair> {
    return this.admin.mfaVerify(user, dto.code, ip);
  }
}

@Controller('admin')
@AdminOnly()
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('listings')
  listings(@Query() q: AdminListingsQueryDto): Promise<AdminListingPage> {
    return this.admin.listings(q);
  }

  @Get('listings/:id')
  listing(@Param('id', uuid) id: string): Promise<AdminListingDetail> {
    return this.admin.listingDetail(id);
  }

  @Post('listings/:id/approve')
  @HttpCode(HttpStatus.OK)
  approve(@CurrentUser() user: AuthUser, @Ip() ip: string, @Param('id', uuid) id: string): Promise<AdminListingStatus> {
    return this.admin.approve({ user, ip }, id);
  }

  @Post('listings/:id/reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @CurrentUser() user: AuthUser,
    @Ip() ip: string,
    @Param('id', uuid) id: string,
    @Body() dto: ReasonDto,
  ): Promise<AdminListingStatus> {
    return this.admin.reject({ user, ip }, id, dto.reason);
  }

  @Post('listings/:id/remove')
  @HttpCode(HttpStatus.OK)
  remove(
    @CurrentUser() user: AuthUser,
    @Ip() ip: string,
    @Param('id', uuid) id: string,
    @Body() dto: ReasonDto,
  ): Promise<AdminListingStatus> {
    return this.admin.remove({ user, ip }, id, dto.reason);
  }

  @Get('listings/:id/exact-location')
  exactLocation(@CurrentUser() user: AuthUser, @Ip() ip: string, @Param('id', uuid) id: string): Promise<LatLng> {
    return this.admin.exactLocation({ user, ip }, id);
  }

  @Get('reports')
  reports(@Query() q: AdminReportsQueryDto): Promise<AdminReportPage> {
    return this.admin.reports(q);
  }

  @Post('reports/:id/resolve')
  @HttpCode(HttpStatus.OK)
  resolve(
    @CurrentUser() user: AuthUser,
    @Ip() ip: string,
    @Param('id', uuid) id: string,
    @Body() dto: ResolveReportDto,
  ): Promise<ResolvedReport> {
    return this.admin.resolveReport({ user, ip }, id, dto);
  }

  @Post('users/:id/restrict')
  @HttpCode(HttpStatus.OK)
  restrict(
    @CurrentUser() user: AuthUser,
    @Ip() ip: string,
    @Param('id', uuid) id: string,
    @Body() dto: RestrictDto,
  ): Promise<UserRestriction> {
    return this.admin.restrict({ user, ip }, id, dto.days, dto.note);
  }

  @Post('users/:id/unrestrict')
  @HttpCode(HttpStatus.OK)
  unrestrict(@CurrentUser() user: AuthUser, @Ip() ip: string, @Param('id', uuid) id: string): Promise<UserRestriction> {
    return this.admin.unrestrict({ user, ip }, id);
  }

  @Get('users/:id/phone')
  phone(@CurrentUser() user: AuthUser, @Ip() ip: string, @Param('id', uuid) id: string): Promise<AdminPhone> {
    return this.admin.phone({ user, ip }, id);
  }

  @Get('metrics')
  metrics(@Query() q: MetricsQueryDto): Promise<Metrics> {
    return this.admin.metrics(q.from, q.to);
  }
}
