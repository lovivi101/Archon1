import { Route } from "../Game/AvalonGameTypes";

export const DEFAULT_SERVER_URL = "ws://127.0.0.1:8888";
export const DEFAULT_ROOM_ID = "888";

export interface DecodedPacket {
    seq: number;
    route: number;
    payload: any;
}

const MAX_PACKET_SEQ = 32767;
let packetSeq = 0;

function nextPacketSeq(): number {
    packetSeq = packetSeq >= MAX_PACKET_SEQ ? 1 : packetSeq + 1;
    return packetSeq;
}

export function encodePacket(route: Route | number, payload: unknown): ArrayBuffer {
    const payloadText = JSON.stringify(payload ?? {});
    const payloadData = new TextEncoder().encode(payloadText);
    const data = new Uint8Array(4 + payloadData.length);
    const view = new DataView(data.buffer);

    view.setUint16(0, nextPacketSeq(), true);
    view.setUint16(2, route, true);
    data.set(payloadData, 4);
    return data.buffer;
}

export function decodeArrayBufferPacket(data: ArrayBuffer): DecodedPacket | null {
    if (!data || data.byteLength < 4) {
        return null;
    }

    const view = new DataView(data);
    const seq = view.getUint16(0, true);
    const route = view.getUint16(2, true);
    const payloadBytes = data.slice(4);
    const payloadText = new TextDecoder().decode(payloadBytes);
    const payload = payloadText ? JSON.parse(payloadText) : {};

    return { seq, route, payload };
}

export function decodeTextPacket(text: string): DecodedPacket | null {
    if (!text) {
        return null;
    }

    const data = JSON.parse(text);
    const route = Number(data.route ?? data.Route ?? data.cmd ?? data.Cmd);
    if (!Number.isFinite(route)) {
        return null;
    }

    return {
        seq: Number(data.seq ?? data.Seq ?? 0),
        route,
        payload: data.data ?? data.Data ?? data.payload ?? data.Payload ?? data,
    };
}
