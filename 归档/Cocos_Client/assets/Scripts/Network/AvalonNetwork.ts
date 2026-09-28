import { routeName, Route } from "../Game/AvalonGameTypes";
import { decodeArrayBufferPacket, decodeTextPacket, encodePacket } from "./AvalonProtocol";

export type ConnectionState = "closed" | "connecting" | "open" | "error";
export type RouteHandler = (payload: any, route: number) => void;
export type StatusHandler = (state: ConnectionState, message: string) => void;
export type DisposeHandler = () => void;

export class AvalonNetwork {
    private static _instance: AvalonNetwork | null = null;

    public static get instance(): AvalonNetwork {
        if (!this._instance) {
            this._instance = new AvalonNetwork();
        }

        return this._instance;
    }

    private _socket: WebSocket | null = null;
    private _handlers: Map<number, Set<RouteHandler>> = new Map();
    private _statusHandlers: Set<StatusHandler> = new Set();
    private _state: ConnectionState = "closed";
    private _lastMessage = "";

    public get state(): ConnectionState {
        return this._state;
    }

    public get lastMessage(): string {
        return this._lastMessage;
    }

    public get isConnected(): boolean {
        return this._socket?.readyState === WebSocket.OPEN;
    }

    public connect(url: string): void {
        const previousSocket = this._socket;
        if (previousSocket) {
            previousSocket.onopen = null;
            previousSocket.onclose = null;
            previousSocket.onerror = null;
            previousSocket.onmessage = null;
            if (previousSocket.readyState !== WebSocket.CLOSED) {
                previousSocket.close();
            }
        }

        this.emitStatus("connecting", `连接中：${url}`);

        try {
            const socket = new WebSocket(url);
            this._socket = socket;
            socket.binaryType = "arraybuffer";
            socket.onopen = (): void => {
                if (this._socket === socket) this.emitStatus("open", "服务器已连接");
            };
            socket.onclose = (): void => {
                if (this._socket === socket) {
                    this._socket = null;
                    this.emitStatus("closed", "连接已关闭");
                }
            };
            socket.onerror = (): void => {
                if (this._socket === socket) this.emitStatus("error", "连接发生错误");
            };
            socket.onmessage = (event: MessageEvent): void => {
                if (this._socket === socket) this.handleMessage(event.data);
            };
        } catch (error) {
            this._socket = null;
            this.emitStatus("error", `创建连接失败：${error}`);
        }
    }

    public close(): void {
        const socket = this._socket;
        this._socket = null;
        if (socket) {
            socket.onopen = null;
            socket.onclose = null;
            socket.onerror = null;
            socket.onmessage = null;
            socket.close();
        }
        this.emitStatus("closed", "连接已关闭");
    }

    public onStatus(handler: StatusHandler): DisposeHandler {
        this._statusHandlers.add(handler);
        return (): void => {
            this._statusHandlers.delete(handler);
        };
    }

    public registerHandler(route: Route | number, handler: RouteHandler): DisposeHandler {
        if (!this._handlers.has(route)) {
            this._handlers.set(route, new Set());
        }

        this._handlers.get(route)!.add(handler);
        return (): void => {
            this._handlers.get(route)?.delete(handler);
        };
    }

    public send(route: Route | number, payload: unknown): boolean {
        if (!this._socket || this._socket.readyState !== WebSocket.OPEN) {
            this.emitStatus(this._state === "connecting" ? "connecting" : "closed", `未连接，${routeName(route)} 未发送`);
            return false;
        }

        try {
            this._socket.send(encodePacket(route, payload));
            return true;
        } catch (error) {
            this.emitStatus("error", `发送失败：${error}`);
            return false;
        }
    }

    private handleMessage(data: ArrayBuffer | Blob | string): void {
        if (typeof Blob !== "undefined" && data instanceof Blob) {
            data.arrayBuffer().then((buffer) => this.handleMessage(buffer)).catch((error) => {
                this.emitStatus("error", `消息读取失败：${error}`);
            });
            return;
        }

        try {
            const packet = typeof data === "string" ? decodeTextPacket(data) : decodeArrayBufferPacket(data as ArrayBuffer);
            if (!packet) {
                this.emitStatus(this._state, "收到无法识别的消息");
                return;
            }

            const handlers = this._handlers.get(packet.route);
            if (!handlers || handlers.size === 0) {
                console.warn(`No handler for ${routeName(packet.route)}`, packet.payload);
                return;
            }

            Array.from(handlers).forEach((handler) => {
                try {
                    handler(packet.payload, packet.route);
                } catch (error) {
                    this.emitStatus("error", `路由 ${routeName(packet.route)} 处理失败：${error}`);
                }
            });
        } catch (error) {
            this.emitStatus("error", `消息解析失败：${error}`);
        }
    }

    private emitStatus(state: ConnectionState, message: string): void {
        this._state = state;
        this._lastMessage = message;
        Array.from(this._statusHandlers).forEach((handler) => {
            try {
                handler(state, message);
            } catch (error) {
                console.error("Avalon network status listener failed", error);
            }
        });
    }
}
