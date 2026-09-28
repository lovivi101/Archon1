extends Node
class_name AvalonNetwork
signal packet_received(route: int, payload: Dictionary)
signal state_changed(state: String, message: String)
const Protocol = preload("res://scripts/network/avalon_protocol.gd")
var peer := WebSocketPeer.new()
var url := ""
var state := "offline"
var elapsed := 0.0

func _process(delta: float) -> void:
	if state in ["offline", "closed", "error"]:
		return
	peer.poll()
	elapsed += delta
	if peer.get_ready_state() == WebSocketPeer.STATE_OPEN:
		if state != "open":
			_set_state("open", "服务器已连接")
		while peer.get_available_packet_count() > 0:
			var decoded := Protocol.decode(peer.get_packet())
			if not decoded.is_empty():
				packet_received.emit(int(decoded.route),decoded.payload)
	elif peer.get_ready_state() == WebSocketPeer.STATE_CLOSED:
		_set_state("closed", "连接已断开")
	elif elapsed > 8.0 and state == "connecting":
		peer.close()
		_set_state("error", "连接超时，请检查服务器地址")

func connect_to_url(target_url: String) -> void:
	peer.close()
	url = target_url.strip_edges()
	if not url.begins_with("ws://") and not url.begins_with("wss://"):
		_set_state("error", "地址必须以 ws:// 或 wss:// 开头")
		return
	peer = WebSocketPeer.new()
	peer.heartbeat_interval = 10.0
	elapsed = 0.0
	var error := peer.connect_to_url(url)
	if error != OK:
		_set_state("error", "无法创建连接：%s" % error)
		return
	_set_state("connecting", "正在连接服务器…")

func close() -> void:
	peer.close()
	peer = WebSocketPeer.new()
	_set_state("closed", "连接已关闭")

func send(route: int, payload: Dictionary) -> bool:
	if peer.get_ready_state() != WebSocketPeer.STATE_OPEN:
		return false
	var bytes := Protocol.encode(route,payload)
	return not bytes.is_empty() and peer.send(bytes,WebSocketPeer.WRITE_MODE_BINARY) == OK

func _set_state(value: String, message: String) -> void:
	state = value
	state_changed.emit(state,message)
