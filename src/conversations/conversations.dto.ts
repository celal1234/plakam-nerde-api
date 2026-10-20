import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsLatitude, IsLongitude, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import { LatLng, UserRef } from '../common/dto/shared.dto';
import type { ListingStatus } from '../listings/listings.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class PointDto {
  @IsLatitude() lat: number;
  @IsLongitude() lng: number;
}

export class StartConversationDto {
  @IsUUID() listingId: string;
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(2000) firstMessage: string;
  // İstemcinin ürettiği kimlik; ağ hatasında tekrar gönderilen mesaj çift kaydedilmez.
  @IsUUID() clientId: string;
}

export class SendMessageDto {
  @IsUUID() clientId: string;
  @IsIn(['text', 'location']) kind: 'text' | 'location';
  @ValidateIf((o) => o.kind === 'text') @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(2000) body?: string;
  @ValidateIf((o) => o.kind === 'location') @ValidateNested() @Type(() => PointDto) point?: PointDto;
}

export class MessagesQueryDto {
  // `after`: koptuktan sonra eşitleme (bu kimlikten sonrakiler, eskiden yeniye).
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) after?: number;
  // `before`: geçmişe doğru sayfalama.
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) before?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
}

// ---- Yanıtlar ----

export class Message {
  // Artan sayısal kimlik (metin olarak); `after`/`before` sayfalaması bununla yapılır.
  id: string;
  conversationId: string;
  // Sistem mesajlarında null.
  senderId: string | null;
  kind: 'text' | 'location' | 'system';
  body: string | null;
  point: LatLng | null;
  clientId: string;
  createdAt: Date;
  readAt: Date | null;
}

export class LastMessage {
  kind: 'text' | 'location' | 'system';
  // İlk 120 karakter.
  body: string | null;
  senderId: string | null;
  createdAt: string;
}

export class ConversationSummary {
  id: string;
  listingId: string;
  plateDisplay: string;
  listingStatus: ListingStatus;
  // İsteği yapan kullanıcının bu konuşmadaki rolü.
  role: 'owner' | 'seeker';
  otherUser: UserRef;
  readOnly: boolean;
  lastMessageAt: Date | null;
  lastMessage: LastMessage | null;
  unread: number;
}

export class StartedConversation {
  conversation: ConversationSummary;
  message: Message;
}

export class ReadReceipt {
  // Okundu işaretlenen en son mesaj; yeni okunan yoksa null.
  upToId: string | null;
}
