extends RefCounted
class_name AvalonProtocol
const MAX_PACKET_BYTES := 65536
static var sequence := 0
static func encode(route: int, payload: Dictionary) -> PackedByteArray:
	var body := JSON.stringify(payload).to_utf8_buffer()
	if route < 0 or route > 65535 or body.size()+4 > MAX_PACKET_BYTES:
		return PackedByteArray()
	sequence = sequence % 32767 + 1
	var packet := PackedByteArray()
	packet.resize(4)
	packet.encode_u16(0,sequence)
	packet.encode_u16(2,route)
	packet.append_array(body)
	return packet
static func decode(packet: PackedByteArray) -> Dictionary:
	if packet.size() < 4 or packet.size() > MAX_PACKET_BYTES:
		return {}
	var json := JSON.new()
	if json.parse(packet.slice(4).get_string_from_utf8()) != OK or not json.data is Dictionary:
		return {}
	return {"seq":packet.decode_u16(0),"route":packet.decode_u16(2),"payload":json.data}
