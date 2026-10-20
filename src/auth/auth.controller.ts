import { Body, Controller, HttpCode, HttpStatus, Ip, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthUser, CurrentUser, Public } from './auth.decorators';
import {
  ForgotPasswordDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
  RegisterResponse,
  ResetPasswordDto,
  TokenDto,
  TokenResponse,
} from './auth.dto';
import { AuthService } from './auth.service';
import { clearRefreshCookie, refreshTokenFrom, sendTokens, TokenTransportHeader } from './refresh-cookie';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() dto: RegisterDto): Promise<RegisterResponse> {
    await this.auth.register(dto);
    return { status: 'verification_sent' };
  }

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.NO_CONTENT)
  verifyEmail(@Body() dto: TokenDto): Promise<void> {
    return this.auth.verifyEmail(dto.token);
  }

  @Post('verify-email/resend')
  @HttpCode(HttpStatus.NO_CONTENT)
  resend(@CurrentUser() user: AuthUser): Promise<void> {
    return this.auth.resendVerification(user);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @TokenTransportHeader()
  async login(
    @Body() dto: LoginDto,
    @Ip() ip: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenResponse> {
    return sendTokens(req, res, await this.auth.login(dto, ip));
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @TokenTransportHeader()
  async refresh(@Body() dto: RefreshDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<TokenResponse> {
    return sendTokens(req, res, await this.auth.refresh(refreshTokenFrom(req, dto.refreshToken)));
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @TokenTransportHeader()
  async logout(@Body() dto: RefreshDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(refreshTokenFrom(req, dto.refreshToken));
    clearRefreshCookie(req, res);
  }

  @Public()
  @Post('password/forgot')
  @HttpCode(HttpStatus.NO_CONTENT)
  forgot(@Body() dto: ForgotPasswordDto, @Ip() ip: string): Promise<void> {
    return this.auth.forgotPassword(dto.email, ip);
  }

  @Public()
  @Post('password/reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  reset(@Body() dto: ResetPasswordDto): Promise<void> {
    return this.auth.resetPassword(dto.token, dto.password);
  }
}
