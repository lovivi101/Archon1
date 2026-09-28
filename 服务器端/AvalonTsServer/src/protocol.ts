import { RawData } from "ws";

export interface Packet {
    seq: number;
    route: number;
    payload: Record<string, any>;
}

/** Binary frame: uint16 LE seq + uint16 LE route + UTF-8 JSON body. JSON text frames are accepted as a fallback. */
export function decodePacket(raw: RawData): Packet | null {
    const buffer = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
    if (buffer.length >= 4) {
        const seq = buffer.readUInt16LE(0);
        const route = buffer.readUInt16LE(2);
        const text = buffer.subarray(4).toString("utf8");
        const payload = text.length > 0 ? JSON.parse(text) : {};
        return { seq, route, payload: isObject(payload) ? payload : {} };
    }

    const text = buffer.toString("utf8");
    if (!text) {
        return null;
    }
    const data = JSON.parse(text);
    const route = Number(data.route ?? data.Route ?? data.cmd ?? data.Cmd);
    if (!Number.isFinite(route)) {
        return null;
    }
    const payload = data.data ?? data.Data ?? data.payload ?? data.Payload ?? data;
    return { seq: Number(data.seq ?? data.Seq ?? 0), route, payload: isObject(payload) ? payload : {} };
}

export function encodePacket(seq: number, route: number, payload: unknown): Buffer {
    const body = Buffer.from(JSON.stringify(payload ?? {}), "utf8");
    const packet = Buffer.allocUnsafe(4 + body.length);
    packet.writeUInt16LE(seq, 0);
    packet.writeUInt16LE(route, 2);
    body.copy(packet, 4);
    return packet;
}

export function isObject(value: unknown): value is Record<string, any> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
