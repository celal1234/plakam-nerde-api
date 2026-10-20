import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Ip, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import { AuthUser, CurrentUser, Public, RequireVerifiedEmail } from '../auth/auth.decorators';
import { ApiError } from '../common/errors/api-error';
import {
  CheckDuplicateDto,
  CloseListingDto,
  CreatedListing,
  CreateListingDto,
  DuplicateCheck,
  ExtendedListing,
  HandoverConfirmation,
  HandoverConfirmDto,
  HandoverDto,
  ListingDetail,
  ListingStatusChange,
  ListingVersion,
  OwnListing,
  PhoneNumber,
  SearchQueryDto,
  SearchResult,
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
  search(@Query() query: SearchQueryDto, @Ip() ip: string): Promise<SearchResult> {
    return this.listings.search(query.q, ip);
  }

  @Post('plates/check-duplicate')
  @HttpCode(HttpStatus.OK)
  checkDuplicate(@Body() dto: CheckDuplicateDto): Promise<DuplicateCheck> {
    return this.listings.checkDuplicate(dto);
  }

  @Post('plates')
  @RequireVerifiedEmail()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateListingDto): Promise<CreatedListing> {
    return this.listings.create(user, dto);
  }

  @Public()
  @Get('plates/:id')
  detail(@Param('id', listingId) id: string): Promise<ListingDetail> {
    return this.listings.detail(id);
  }

  @Get('plates/:id/phone')
  phone(@CurrentUser() user: AuthUser, @Param('id', listingId) id: string): Promise<PhoneNumber> {
    return this.listings.phone(user, id);
  }

  @Patch('plates/:id')
  @ApiHeader({ name: 'If-Match', required: true, description: 'İlanın `version` değeri' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', listingId) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() dto: UpdateListingDto,
  ): Promise<ListingVersion> {
    return this.listings.update(user, id, ifMatch, dto);
  }

  @Post('plates/:id/extend')
  @HttpCode(HttpStatus.OK)
  extend(@CurrentUser() user: AuthUser, @Param('id', listingId) id: string): Promise<ExtendedListing> {
    return this.listings.extend(user, id);
  }

  @Post('plates/:id/close')
  @HttpCode(HttpStatus.OK)
  close(@CurrentUser() user: AuthUser, @Param('id', listingId) id: string, @Body() dto: CloseListingDto): Promise<ListingStatusChange> {
    return this.listings.close(user, id, dto.reason);
  }

  @Post('plates/:id/handover')
  @HttpCode(HttpStatus.OK)
  handover(@CurrentUser() user: AuthUser, @Param('id', listingId) id: string, @Body() dto: HandoverDto): Promise<ListingStatusChange> {
    return this.listings.handover(user, id, dto.conversationId);
  }

  @Post('plates/:id/handover-confirm')
  @HttpCode(HttpStatus.OK)
  confirmHandover(
    @CurrentUser() user: AuthUser,
    @Param('id', listingId) id: string,
    @Body() dto: HandoverConfirmDto,
  ): Promise<HandoverConfirmation> {
    return this.listings.confirmHandover(user, id, dto.confirmed);
  }

  @Get('me/listings')
  mine(@CurrentUser() user: AuthUser): Promise<OwnListing[]> {
    return this.listings.mine(user);
  }
}
