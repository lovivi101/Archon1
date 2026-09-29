import { Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, SubscribeMessage, WebSocketGateway } from "@nestjs/websockets";
import { WebSocket, RawData } from "ws";
import { AvalonGameService, ClientConnection } from "./game.service";
import { MAX_PACKET_BYTES, decodePacket, packetSize } from "./protocol";

const HEARTBEAT_MS = Math.max(1000, Number(process.env.AVALON_HEARTBEAT_MS ?? 30000) || 30000);

interface SocketState {
    client: ClientConnection;
    connectionId: string;
    /** Cleared on each heartbeat, set again by a pong or any packet. */
    alive: boolean;
    /** Packets from one socket are handled strictly in order. */
    pending: Promise<void>;
}

// maxPayload makes ws reject oversized frames before buffering them (close code 1009).
@WebSocketGateway({ maxPayload: MAX_PACKET_BYTES })
export class AvalonGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(AvalonGateway.name);
    private readonly sockets = new Map<WebSocket, SocketState>();
    private heartbeat?: NodeJS.Timeout;

    public constructor(private readonly game: AvalonGameService) {}

    public onModuleInit(): void {
        // Terminate sockets that stopped answering pings (half-open TCP, sleeping phones), so the
        // seat goes to autopilot and the room can close instead of waiting on a dead connection.
        this.heartbeat = setInterval(() => {
            for (const [socket, state] of this.sockets) {
                if (!state.alive) {
                    this.logger.warn({ event: "ws.heartbeat_timeout", connectionId: state.connectionId });
                    socket.terminate();
                    continue;
                }
                state.alive = false;
                socket.ping();
            }
        }, HEARTBEAT_MS);
        this.heartbeat.unref();
    }

    public onModuleDestroy(): void {
        clearInterval(this.heartbeat);
    }

    public handleConnection(socket: WebSocket): void {
        const state: SocketState = { client: this.game.connect(socket), connectionId: randomUUID(), alive: true, pending: Promise.resolve() };
        this.sockets.set(socket, state);
        socket.on("pong", () => {
            state.alive = true;
        });
        this.logger.log({ event: "ws.connected", connectionId: state.connectionId });
    }

    @SubscribeMessage("packet")
    public async handlePacket(@ConnectedSocket() socket: WebSocket, @MessageBody() raw: RawData): Promise<void> {
        const state = this.sockets.get(socket);
        if (!state) return;
        state.alive = true;
        const bytes = packetSize(raw);
        if (bytes > MAX_PACKET_BYTES) {
            this.logger.warn({ event: "ws.packet_too_large", connectionId: state.connectionId, bytes });
            socket.close(1009, "Packet too large");
            return;
        }
        const current = state.pending.then(async () => {
            if (socket.readyState !== WebSocket.OPEN) return;
            try {
                const packet = decodePacket(raw);
                if (!packet) {
                    this.logger.warn({ event: "ws.invalid_packet", connectionId: state.connectionId });
                    socket.close(1003, "Invalid packet");
                    return;
                }
                const started = Date.now();
                await this.game.handle(state.client, packet);
                this.logger.log({ event: "ws.packet", connectionId: state.connectionId, seq: packet.seq, route: packet.route, durationMs: Date.now() - started });
            } catch (error) {
                this.logger.error({ event: "ws.packet_error", connectionId: state.connectionId, error: String(error) }, error instanceof Error ? error.stack : undefined);
                socket.close(1003, "Invalid packet");
            }
        });
        state.pending = current;
        await current;
    }

    public handleDisconnect(socket: WebSocket): void {
        const state = this.sockets.get(socket);
        if (!state) return;
        this.game.disconnect(state.client);
        this.sockets.delete(socket);
        this.logger.log({ event: "ws.disconnected", connectionId: state.connectionId });
    }
}
