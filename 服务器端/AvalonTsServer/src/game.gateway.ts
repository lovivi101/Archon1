import { Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, SubscribeMessage, WebSocketGateway } from "@nestjs/websockets";
import { WebSocket, RawData } from "ws";
import { AvalonGameService, ClientConnection, decodePacket } from "./game.service";

@WebSocketGateway()
export class AvalonGateway implements OnGatewayConnection, OnGatewayDisconnect {
    private readonly logger = new Logger(AvalonGateway.name);
    private readonly connections = new Map<WebSocket, ClientConnection>();
    private readonly connectionIds = new Map<WebSocket, string>();
    private readonly pending = new Map<WebSocket, Promise<void>>();

    public constructor(private readonly game: AvalonGameService) {}

    public handleConnection(socket: WebSocket): void {
        const client = this.game.connect(socket);
        this.connections.set(socket, client);
        const connectionId = randomUUID();
        this.connectionIds.set(socket, connectionId);
        this.logger.log({ event: "ws.connected", connectionId });
    }

    @SubscribeMessage("packet")
    public async handlePacket(@ConnectedSocket() socket: WebSocket, @MessageBody() raw: RawData): Promise<void> {
        const client = this.connections.get(socket);
        if (!client) return;
        const connectionId = this.connectionIds.get(socket);
        const packetBytes = Buffer.isBuffer(raw) ? raw.length : typeof raw === "string" ? Buffer.byteLength(raw) : Array.isArray(raw) ? raw.reduce((total, part) => total + part.length, 0) : raw.byteLength;
        if (packetBytes > 65536) {
            this.logger.warn({ event: "ws.packet_too_large", connectionId, bytes: packetBytes });
            socket.close(1009, "Packet too large");
            return;
        }
        const previous = this.pending.get(socket) ?? Promise.resolve();
        const current = previous.then(async () => {
            try {
                const packet = decodePacket(raw);
                if (!packet) {
                    this.logger.warn({ event: "ws.invalid_packet", connectionId });
                    socket.close(1003, "Invalid packet");
                    return;
                }
                const started = Date.now();
                await this.game.handle(client, packet);
                this.logger.log({ event: "ws.packet", connectionId, seq: packet.seq, route: packet.route, durationMs: Date.now() - started });
            } catch (error) {
                this.logger.error({ event: "ws.packet_error", connectionId, error: String(error) }, error instanceof Error ? error.stack : undefined);
                socket.close(1003, "Invalid packet");
            }
        });
        this.pending.set(socket, current);
        await current;
        if (this.pending.get(socket) === current) this.pending.delete(socket);
    }

    public handleDisconnect(socket: WebSocket): void {
        const client = this.connections.get(socket);
        if (client) this.game.disconnect(client);
        this.connections.delete(socket);
        this.pending.delete(socket);
        this.logger.log({ event: "ws.disconnected", connectionId: this.connectionIds.get(socket) });
        this.connectionIds.delete(socket);
    }
}
