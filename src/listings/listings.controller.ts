import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Ip, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, Public, RequireVerifiedEmail } from '../auth/auth.decorators';
import { ApiError } from '../common/errors/api-error';
import {
  CheckDuplicateDto,
  CloseListingDto,
  CreateListingDto,
  HandoverDto,
  SearchQueryDto,
  UpdateListingDto,
} from './listings.dto';
import { ListingsService } from './listings.service';

// Geçersiz kimlik de "ilan yok" sayılır; var/yok bilgisi sızdırılmaz.
const listingId = new ParseUUIDPipe({
  exceptionFactory: () => new ApiError(HttpStatus.NOT_FOUND, 'LISTING_NOT_FOUND', 'İlan bulunamadı.'),
});

@Controller()
export class ListingsController {
  constructor(private readonly listings: ListingsService) {}

  @Public()
  @Get('plates/search')
  search(@Query() query: SearchQueryDto, @Ip() ip: string) {
    return this.listings.search(query.q, ip);
  }

  @Post('plates/check-duplicate')
  @HttpCode(HttpStatus.OK)
  checkDuplicate(@Body() dto: CheckDuplicateDto) {
    return this.listings.checkDuplicate(dto);
  }

  @Post('plates')
  @RequireVerifiedEmail()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateListingDto) {
    return this.listings.create(user, dto);
  }

  @Public()
  @Get('plates/:id')
  detail(@Param('id', listingId) id: string) {
    return this.listings.detail(id);
  }

  @Patch('plates/:id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', listingId) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() dto: UpdateListingDto,
  ) {
    return this.listings.update(user, id, ifMatch, dto);
  }

  @Post('plates/:id/extend')
  @HttpCode(HttpStatus.OK)
  extend(@CurrentUser() user: AuthUser, @Param('id', listingId) id: string) {
    return this.listings.extend(user, id);
  }

  @Post('plates/:id/close')
  @HttpCode(HttpStatus.OK)
  close(@CurrentUser() user: AuthUser, @Param('id', listingId) id: string, @Body() dto: CloseListingDto) {
    return this.listings.close(user, id, dto.reason);
  }

  @Post('plates/:id/handover')
  @HttpCode(HttpStatus.OK)
  handover(@CurrentUser() user: AuthUser, @Param('id', listingId) id: string, @Body() dto: HandoverDto) {
    return this.listings.handover(user, id, dto.conversationId);
  }

  @Get('me/listings')
  mine(@CurrentUser() user: AuthUser) {
    return this.listings.mine(user);
  }
}
