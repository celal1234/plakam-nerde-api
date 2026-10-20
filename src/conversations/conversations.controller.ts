import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, RequireVerifiedEmail } from '../auth/auth.decorators';
import { ApiError } from '../common/errors/api-error';
import {
  ConversationSummary,
  Message,
  MessagesQueryDto,
  ReadReceipt,
  SendMessageDto,
  StartConversationDto,
  StartedConversation,
} from './conversations.dto';
import { ConversationsService } from './conversations.service';

const conversationId = new ParseUUIDPipe({
  exceptionFactory: () => new ApiError(HttpStatus.FORBIDDEN, 'CONVERSATION_FORBIDDEN', 'Bu konuşmaya erişiminiz yok.'),
});
const userId = new ParseUUIDPipe({
  exceptionFactory: () => new ApiError(HttpStatus.NOT_FOUND, 'USER_NOT_FOUND', 'Kullanıcı bulunamadı.'),
});

@Controller()
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Post('conversations')
  @RequireVerifiedEmail()
  start(@CurrentUser() user: AuthUser, @Body() dto: StartConversationDto): Promise<StartedConversation> {
    return this.conversations.start(user, dto);
  }

  @Get('conversations')
  list(@CurrentUser() user: AuthUser): Promise<ConversationSummary[]> {
    return this.conversations.list(user);
  }

  @Get('conversations/:id/messages')
  messages(
    @CurrentUser() user: AuthUser,
    @Param('id', conversationId) id: string,
    @Query() q: MessagesQueryDto,
  ): Promise<Message[]> {
    return this.conversations.messages(user, id, q);
  }

  @Post('conversations/:id/messages')
  send(@CurrentUser() user: AuthUser, @Param('id', conversationId) id: string, @Body() dto: SendMessageDto): Promise<Message> {
    return this.conversations.send(user, id, dto);
  }

  @Post('conversations/:id/read')
  @HttpCode(HttpStatus.OK)
  read(@CurrentUser() user: AuthUser, @Param('id', conversationId) id: string): Promise<ReadReceipt> {
    return this.conversations.markRead(user, id);
  }

  @Post('users/:id/block')
  @HttpCode(HttpStatus.NO_CONTENT)
  block(@CurrentUser() user: AuthUser, @Param('id', userId) id: string): Promise<void> {
    return this.conversations.block(user, id);
  }
}
