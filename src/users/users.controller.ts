import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Patch } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/auth.decorators';
import { DeletedAccount, Me, NotificationPrefs, NotificationPrefsDto, PhoneDto, PhoneLast4, UpdateMeDto } from './users.dto';
import { UsersService } from './users.service';

@Controller('me')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  me(@CurrentUser() user: AuthUser): Promise<Me> {
    return this.users.me(user.id);
  }

  @Patch()
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateMeDto): Promise<Me> {
    return this.users.update(user.id, dto);
  }

  @Delete()
  @HttpCode(HttpStatus.ACCEPTED)
  async remove(@CurrentUser() user: AuthUser): Promise<DeletedAccount> {
    await this.users.deleteAccount(user.id);
    return { status: 'deleted' };
  }

  @Get('phone')
  phone(@CurrentUser() user: AuthUser): Promise<PhoneLast4> {
    return this.users.phone(user.id);
  }

  @Patch('phone')
  setPhone(@CurrentUser() user: AuthUser, @Body() dto: PhoneDto): Promise<PhoneLast4> {
    return this.users.setPhone(user.id, dto.phone);
  }

  @Delete('phone')
  @HttpCode(HttpStatus.NO_CONTENT)
  deletePhone(@CurrentUser() user: AuthUser): Promise<void> {
    return this.users.deletePhone(user.id);
  }

  @Get('notification-prefs')
  prefs(@CurrentUser() user: AuthUser): Promise<NotificationPrefs> {
    return this.users.notificationPrefs(user.id);
  }

  @Patch('notification-prefs')
  updatePrefs(@CurrentUser() user: AuthUser, @Body() dto: NotificationPrefsDto): Promise<NotificationPrefs> {
    return this.users.updateNotificationPrefs(user.id, dto);
  }
}
