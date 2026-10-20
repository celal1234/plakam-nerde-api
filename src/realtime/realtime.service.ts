import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Server } from 'node:http';
import { Redis } from 'ioredis';
import { WebSocket, WebSocketServer } from 'ws';
import { REDIS } from '../redis/redis.module';

export type RealtimeEvent =
  | { type: 'message.new'; message: unknown }
  | { type: 'message.read'; conversationId: string; upToId: string; readerId: string }
  | { type: 'conversation.readonly'; conversationId: string }
  | { type: 'listing.status'; listingId: string; status: string };

const CHANNEL = 'realtime';
const AUTH_TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 30000;

// `wss://…/api/v1/ws`. İstemci bağlanınca ilk mesaj olarak `{"type":"auth","token":"<access JWT>"}` gönderir
// (token adreste taşınmaz, loglara düşmez). Olaylar Redis pub/sub ile tüm API kopyalarına dağıtılır;
// her kopya yalnızca kendine bağlı soketlere iletir. Kopunca istemci `GET …/messages?after=` ile eşitlenir (FR-032).
@Injectable()
export class RealtimeService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Realtime');
  private readonly sockets = new Map<string, Set<WebSocket>>();
  private wss?: WebSocketServer;
  private subscriber?: Redis;
  private heartbeat?: NodeJS.Timeout;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly jwt: JwtService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async publish(userIds: string[], event: RealtimeEvent): Promise<void> {
    await this.redis.publish(CHANNEL, JSON.stringify({ userIds, event }));
  }

  async onApplicationBootstrap() {
    this.subscriber = this.redis.duplicate();
    await this.subscriber.subscribe(CHANNEL);
    this.subscriber.on('message', (_channel, raw: string) => {
      const { userIds, event } = JSON.parse(raw) as { userIds: string[]; event: RealtimeEvent };
      const data = JSON.stringify(event);
      for (const id of userIds) for (const ws of this.sockets.get(id) ?? []) ws.send(data);
    });

    const server: Server = this.adapterHost.httpAdapter.getHttpServer();
    this.wss = new WebSocketServer({ server, path: '/api/v1/ws', maxPayload: 4096 });
    this.wss.on('connection', (ws) => this.onConnection(ws));
    this.heartbeat = setInterval(() => {
      for (const ws of this.wss?.clients ?? []) {
        const alive = ws as WebSocket & { alive?: boolean };
        if (alive.alive === false) {
          ws.terminate();
          continue;
        }
        alive.alive = false;
        ws.ping();
      }
    }, HEARTBEAT_MS);
  }

  async onApplicationShutdown() {
    clearInterval(this.heartbeat);
    for (const ws of this.wss?.clients ?? []) ws.terminate();
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
    await this.subscriber?.quit();
  }

  private onConnection(ws: WebSocket & { alive?: boolean }) {
    ws.alive = true;
    ws.on('pong', () => (ws.alive = true));
    const timer = setTimeout(() => ws.close(4401, 'auth timeout'), AUTH_TIMEOUT_MS);

    ws.once('message', async (raw) => {
      clearTimeout(timer);
      let userId: string;
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string; token?: string };
        if (msg.type !== 'auth' || !msg.token) throw new Error('auth expected');
        userId = (await this.jwt.verifyAsync<{ sub: string }>(msg.token)).sub;
      } catch {
        ws.close(4401, 'unauthorized');
        return;
      }
      const set = this.sockets.get(userId) ?? new Set();
      set.add(ws);
      this.sockets.set(userId, set);
      ws.on('close', () => {
        set.delete(ws);
        if (!set.size) this.sockets.delete(userId);
      });
      // Kimlik doğrulandıktan sonra istemciden gelen mesajlar yok sayılır; gönderme REST üzerinden.
      ws.send(JSON.stringify({ type: 'ready' }));
    });
    ws.on('error', (e) => this.logger.warn(e.message));
  }
}
