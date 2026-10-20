import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Patch } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/auth.decorators';
import { NotificationPrefsDto, PhoneDto, UpdateMeDto } from './users.dto';
import { UsersService } from './users.service';

@Controller('me')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  me(@CurrentUser() user: AuthUser) {
    return this.users.me(user.id);
  }

  @Patch()
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateMeDto) {
    return this.users.update(user.id, dto);
  }

  @Delete()
  @HttpCode(HttpStatus.ACCEPTED)
  async remove(@CurrentUser() user: AuthUser) {
    await this.users.deleteAccount(user.id);
    return { status: 'deleted' };
  }

  @Get('phone')
  phone(@CurrentUser() user: AuthUser) {
    return this.users.phone(user.id);
  }

  @Patch('phone')
  setPhone(@CurrentUser() user: AuthUser, @Body() dto: PhoneDto) {
    return this.users.setPhone(user.id, dto.phone);
  }

  @Delete('phone')
  @HttpCode(HttpStatus.NO_CONTENT)
  deletePhone(@CurrentUser() user: AuthUser) {
    return this.users.deletePhone(user.id);
  }

  @Get('notification-prefs')
  prefs(@CurrentUser() user: AuthUser) {
    return this.users.notificationPrefs(user.id);
  }

  @Patch('notification-prefs')
  updatePrefs(@CurrentUser() user: AuthUser, @Body() dto: NotificationPrefsDto) {
    return this.users.updateNotificationPrefs(user.id, dto);
  }
}
