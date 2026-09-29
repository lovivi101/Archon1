extends RefCounted
## Local profile, replay and contacts. No pretend cloud data.
var path := "user://profile.json"
var data: Dictionary = {"id":"", "nickname":"湖中之剑", "url":"ws://127.0.0.1:8888", "avatar":"avatar-player-knight", "friends":[], "matches":[], "tokens":{}, "agreed":false, "muted":false}
func load_data() -> void:
	if FileAccess.file_exists(path):
		var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(path))
		if parsed is Dictionary:
			data.merge(parsed,true)
	if str(data.id).is_empty():
		data.id = "godot-%d-%d" % [Time.get_unix_time_from_system(),randi()%100000]
		save()
func save() -> void:
	var file := FileAccess.open(path,FileAccess.WRITE)
	if file:
		file.store_string(JSON.stringify(data,"\t"))
func record(snapshot: Dictionary) -> void:
	var entry := snapshot.duplicate(true)
	entry.time = Time.get_datetime_string_from_system(false, true)
	data.matches.push_front(entry)
	if data.matches.size() > 30:
		data.matches.resize(30)
	save()
func add_friend(nickname: String) -> bool:
	var name := nickname.strip_edges().left(20)
	if name.is_empty() or name in data.friends:
		return false
	data.friends.append(name)
	save()
	return true
