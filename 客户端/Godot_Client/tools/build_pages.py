from pathlib import Path
from PIL import Image
import shutil, json

project = Path("客户端/Godot_Client")
source = Path("素材/UI拆分资产")
target = project/"assets"/"ui"
target.mkdir(parents=True,exist_ok=True)
names = [
"game_logo_title",
"button_primary_blue","button_secondary_dark","button_danger_red",
"panel_header_empty","panel_content_large","panel_modal_large","panel_list_row",
"panel_mission_hud","slot_team_member","card_role_back","card_role_front",
"avatar-merlin","avatar-player-knight","avatar-morgana","avatar-assassin",
"avatar-loyal-female","avatar-dwarf-warrior","avatar-empty-slot",
"role-merlin","role-assassin","role-servant","banner_good_blue","banner_evil_red",
"home-icon","leaderboard-icon","friends-icon","settings-icon","sound-icon",
"check-icon","plus-icon","crown-icon","target-icon","trophy-icon",
"brain-icon","share-icon","timer-icon","microphone-icon","thumbs-approve-icon",
"thumbs-reject-icon","mission-success-emblem","mission-failure-emblem",
"invite-swords-icon","back-icon",
]
bg = [
"bg-main-hall-750x1334", "bg-round-table-hall-750x1334",
"bg-role-reveal-hall-750x1334", "bg-voting-hall-750x1334",
"bg-mission-table-750x1334", "bg-assassination-hall-750x1334",
"bg-records-hall-750x1334", "bg-friends-library-750x1334",
]
catalog = {}
for name in names+bg:
    found = list((source/"00-共享资产").rglob(name+".png"))
    if not found:
        print("MISSING",name)
        continue
    out = target/(name+".png")
    shutil.copy2(found[0],out)
    image = Image.open(out).convert("RGBA")
    a = image.getchannel("A").point(lambda v: 255 if v>16 else 0)
    box = a.getbbox() or (0,0,image.width,image.height)
    catalog[name] = [box[0],box[1],box[2]-box[0],box[3]-box[1]]
(target/"catalog.json").write_text(json.dumps(catalog,ensure_ascii=False,indent=2),encoding="utf-8")
mapping = {
2:"bg-main-hall-750x1334",3:"bg-round-table-hall-750x1334",
4:"bg-round-table-hall-750x1334",5:"bg-role-reveal-hall-750x1334",
6:"bg-role-reveal-hall-750x1334",7:"bg-round-table-hall-750x1334",
8:"bg-round-table-hall-750x1334",9:"bg-voting-hall-750x1334",
10:"bg-role-reveal-hall-750x1334",11:"bg-mission-table-750x1334",
12:"bg-assassination-hall-750x1334",13:"bg-records-hall-750x1334",
14:"bg-records-hall-750x1334",15:"bg-records-hall-750x1334",
16:"bg-friends-library-750x1334"
}
for number,background in mapping.items():
    scene = f'''[gd_scene load_steps=3 format=3]

[ext_resource type="Script" path="res://scripts/views/page_view.gd" id="1"]
[ext_resource type="Texture2D" path="res://assets/ui/{background}.png" id="2"]

[node name="Page{number:02d}" type="Control"]
layout_mode = 3
offset_right = 750.0
offset_bottom = 1334.0
texture_filter = 4
clip_contents = true
script = ExtResource("1")
page_id = {number}

[node name="Background" type="TextureRect" parent="."]
layout_mode = 0
offset_right = 750.0
offset_bottom = 1334.0
mouse_filter = 2
texture = ExtResource("2")
expand_mode = 1
stretch_mode = 5
'''
    (project/"scenes"/f"page_{number:02d}.tscn").write_text(scene,encoding="utf-8")
print(f"created {len(mapping)} scenes and {len(catalog)} original aspect-preserving assets")
