"""Build the editable Godot scene from the supplied split assets; no raster edits."""
from pathlib import Path
import shutil

PROJECT = Path(__file__).resolve().parents[1]
SOURCE = PROJECT.parents[1] / '素材' / 'UI拆分资产' / '01-登录界面'
ASSETS = PROJECT / 'assets' / 'login'
ASSETS.mkdir(parents=True, exist_ok=True)
(PROJECT / 'scenes').mkdir(exist_ok=True)
files = {
    'background': 'bg-main-hall-750x1334.png',
    'logo': 'game_logo_title.png',
    'wechat_button': 'button_login_green.png',
    'guest_button': 'button_secondary_dark.png',
    'sound': 'sound-icon.png',
    'settings': 'settings-icon.png',
}
for key, filename in files.items():
    shutil.copy2(next(SOURCE.rglob(filename)), ASSETS / (key + '.png'))

# Small missing UI glyphs are editable vector assets, not screenshot cutouts.
(ASSETS / 'wechat.svg').write_text('''<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48" viewBox="0 0 64 48">
<g fill="#e0ddbf"><path d="M12 27 L8 36 L22 30Z"/><ellipse cx="25" cy="19" rx="22" ry="17"/></g>
<g fill="#173026"><circle cx="17" cy="15" r="2.2"/><circle cx="32" cy="15" r="2.2"/></g>
<g fill="#e0ddbf" stroke="#193024" stroke-width="1.4"><path d="M45 40 L57 46 L55 36"/><ellipse cx="44" cy="31" rx="19" ry="14"/></g>
<g fill="#173026"><circle cx="38" cy="28" r="1.8"/><circle cx="51" cy="28" r="1.8"/></g></svg>''', encoding='utf-8')
for checked in [False, True]:
    tick = '<path d="M6 13L11 18L21 7" fill="none" stroke="#d4bc83" stroke-width="2.5"/>' if checked else ''
    (ASSETS / ('checked.svg' if checked else 'unchecked.svg')).write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="26" viewBox="0 0 28 26">'
        '<rect x="2" y="2" width="24" height="22" rx="2" fill="#080d10" stroke="#aa9570" stroke-width="1.6"/>'
        + tick + '</svg>', encoding='utf-8')

ext = []
for name in files:
    ext.append(f'[ext_resource type="Texture2D" path="res://assets/login/{name}.png" id="{name}"]')
for name in ['wechat', 'checked', 'unchecked']:
    ext.append(f'[ext_resource type="Texture2D" path="res://assets/login/{name}.svg" id="{name}"]')
ext.append('[ext_resource type="Script" path="res://scripts/login.gd" id="script"]')
sub = []
def resource(kind, name, properties):
    sub.append(f'[sub_resource type="{kind}" id="{name}"]\n{properties}')
def atlas(name, texture, x, y, w, h):
    resource('AtlasTexture', name, f'atlas = ExtResource("{texture}")\nregion = Rect2({x}, {y}, {w}, {h})\nfilter_clip = true')

# Transparent padding is removed with AtlasTexture regions in the engine;
# the source PNGs are copied verbatim and remain untouched.
atlas('LogoAtlas', 'logo', 210, 9, 1360, 867)
atlas('WechatAtlas', 'wechat_button', 15, 180, 2143, 345)
atlas('GuestAtlas', 'guest_button', 45, 155, 2083, 412)
atlas('SoundAtlas', 'sound', 79, 277, 1096, 703)
atlas('SettingsAtlas', 'settings', 140, 118, 973, 999)
resource('SystemFont', 'Serif', 'font_names = PackedStringArray("SimSun", "宋体")\nfont_weight = 700')
resource('FontVariation', 'BoldSerif', 'base_font = SubResource("Serif")\nvariation_embolden = 0.8\nspacing_glyph = 2')
resource('SystemFont', 'Sans', 'font_names = PackedStringArray("Microsoft YaHei", "微软雅黑")')
resource('StyleBoxEmpty', 'Empty', '')
resource('StyleBoxFlat', 'RoundNormal', '''bg_color = Color(0.035, 0.045, 0.048, 0.94)
border_width_left = 2
border_width_top = 2
border_width_right = 2
border_width_bottom = 2
border_color = Color(0.62, 0.51, 0.34, 1)
corner_radius_top_left = 28
corner_radius_top_right = 28
corner_radius_bottom_left = 28
corner_radius_bottom_right = 28
shadow_color = Color(0, 0, 0, 0.85)
shadow_size = 3''')
resource('StyleBoxFlat', 'RoundHover', '''bg_color = Color(0.09, 0.11, 0.12, 0.96)
border_width_left = 2
border_width_top = 2
border_width_right = 2
border_width_bottom = 2
border_color = Color(0.83, 0.70, 0.48, 1)
corner_radius_top_left = 28
corner_radius_top_right = 28
corner_radius_bottom_left = 28
corner_radius_bottom_right = 28''')
resource('Gradient', 'BottomGradient', 'offsets = PackedFloat32Array(0, 0.35, 1)\ncolors = PackedColorArray(0, 0, 0, 0, 0, 0, 0, 0.23, 0, 0, 0, 0.65)')
resource('GradientTexture2D', 'BottomShade', 'gradient = SubResource("BottomGradient")\nwidth = 2\nheight = 512\nfill_from = Vector2(0, 0)\nfill_to = Vector2(0, 1)')
nodes = []
def node(name, kind, parent=None, rect=None, properties=''):
    header = f'[node name="{name}" type="{kind}"' + (f' parent="{parent}"' if parent is not None else '') + ']'
    props = []
    if rect:
        x,y,w,h = rect
        props += ['layout_mode = 0', f'offset_left = {float(x)}', f'offset_top = {float(y)}', f'offset_right = {float(x+w)}', f'offset_bottom = {float(y+h)}']
    if properties:
        props.append(properties)
    nodes.append(header + '\n' + '\n'.join(props))
def aspect_height(width, source_width, source_height):
    return round(width * source_height / source_width, 2)
def texture(name, parent, rect, tex, extra='', preserve_aspect=True):
    mode = 5 if preserve_aspect else 0 # KEEP_ASPECT_CENTERED / SCALE
    node(name, 'TextureRect', parent, rect, f'mouse_filter = 2\ntexture = {tex}\nexpand_mode = 1\nstretch_mode = {mode}\n' + extra)
def label(name, parent, rect, text, size, serif=False, color='Color(0.86, 0.84, 0.74, 1)', extra=''):
    node(name, 'Label', parent, rect, f'mouse_filter = 2\ntheme_override_fonts/font = SubResource("{"BoldSerif" if serif else "Sans"}")\ntheme_override_font_sizes/font_size = {size}\ntheme_override_colors/font_color = {color}\ntheme_override_colors/font_shadow_color = Color(0, 0, 0, 0.95)\ntheme_override_constants/shadow_offset_x = 1\ntheme_override_constants/shadow_offset_y = 2\ntext = "{text}"\nhorizontal_alignment = 1\nvertical_alignment = 1\n' + extra)
def text_button(name, parent, rect, text, size, color):
    node(name, 'Button', parent, rect, f'mouse_default_cursor_shape = 2\nfocus_mode = 0\nflat = true\ntheme_override_fonts/font = SubResource("Sans")\ntheme_override_font_sizes/font_size = {size}\ntheme_override_colors/font_color = {color}\ntheme_override_colors/font_hover_color = Color(0.85, 0.91, 1, 1)\ntheme_override_styles/normal = SubResource("Empty")\ntheme_override_styles/hover = SubResource("Empty")\ntheme_override_styles/pressed = SubResource("Empty")\ntext = "{text}"')

node('Login', 'Control', rect=(0,0,750,1334), properties='texture_filter = 4\nclip_contents = true\nscript = ExtResource("script")')
texture('Background', '.', (0,0,750,1334), 'ExtResource("background")', 'modulate = Color(0.78, 0.78, 0.78, 1)', False)
texture('BottomShade', '.', (0,810,750,524), 'SubResource("BottomShade")', '', False)
# Uniform scaling only: target width determines the height from the atlas region ratio.
texture('Logo', '.', (85,130,580,aspect_height(580,1360,867)), 'SubResource("LogoAtlas")')
node('Toolbar', 'Control', '.', (0,0,750,100), 'mouse_filter = 2')
for name, x, atlas_name, icon_rect in [('SoundButton',574,'SoundAtlas',(12,13,31,23)),('SettingsButton',664,'SettingsAtlas',(14,11,28,28))]:
    node(name,'Button','Toolbar',(x,35,55,48),'mouse_default_cursor_shape = 2\nfocus_mode = 0\ntheme_override_styles/normal = SubResource("RoundNormal")\ntheme_override_styles/hover = SubResource("RoundHover")\ntheme_override_styles/pressed = SubResource("RoundHover")\n' + ('toggle_mode = true\ntooltip_text = "关闭声音"' if name=='SoundButton' else 'tooltip_text = "设置"'))
    iw, ih = icon_rect[2], icon_rect[3]
    texture('Icon','Toolbar/'+name,(icon_rect[0],icon_rect[1],iw,aspect_height(iw,1096 if name == 'SoundButton' else 973,703 if name == 'SoundButton' else 999)),f'SubResource("{atlas_name}")')
node('MuteMark','Label','Toolbar/SoundButton',(0,0,55,48),'visible = false\nmouse_filter = 2\ntheme_override_colors/font_color = Color(0.91, 0.68, 0.44, 1)\ntheme_override_font_sizes/font_size = 36\ntext = "╱"\nhorizontal_alignment = 1\nvertical_alignment = 1')
node('Actions','Control','.',(0,0,750,1334),'mouse_filter = 2')
for name,rect,tex,src_w,src_h in [('WechatButton',(142,938,466,aspect_height(466,2143,345)),'WechatAtlas',2143,345),('GuestButton',(174,1047,402,aspect_height(402,2083,412)),'GuestAtlas',2083,412)]:
    node(name,'TextureButton','Actions',rect,f'mouse_default_cursor_shape = 2\nfocus_mode = 0\ntexture_normal = SubResource("{tex}")\nignore_texture_size = true\nstretch_mode = 5')
texture('WechatIcon','Actions/WechatButton',(113,23,62,aspect_height(62,64,48)),'ExtResource("wechat")')
label('Title','Actions/WechatButton',(187,9,174,58),'微信登录',34,True,extra='theme_override_colors/font_outline_color = Color(0.02, 0.03, 0.02, 1)\ntheme_override_constants/outline_size = 3')
label('Title','Actions/GuestButton',(64,8,274,55),'游客体验',29,True,extra='theme_override_colors/font_outline_color = Color(0.015, 0.015, 0.015, 1)\ntheme_override_constants/outline_size = 3')
node('Agreement','Control','.',(171,1151,410,31),'mouse_filter = 2')
node('CheckBox','CheckBox','Agreement',(0,0,29,29),'mouse_default_cursor_shape = 2\nfocus_mode = 0\ntheme_override_icons/checked = ExtResource("checked")\ntheme_override_icons/unchecked = ExtResource("unchecked")\ntheme_override_styles/normal = SubResource("Empty")\ntheme_override_styles/hover = SubResource("Empty")\ntheme_override_styles/pressed = SubResource("Empty")\ntheme_override_styles/hover_pressed = SubResource("Empty")')
label('Prefix','Agreement',(40,0,131,29),'我已阅读并同意',17,color='Color(0.71, 0.70, 0.66, 1)')
text_button('Terms','Agreement',(175,0,105,29),'《用户协议》',17,'Color(0.47, 0.66, 0.83, 1)')
label('And','Agreement',(281,0,27,29),'和',17,color='Color(0.71, 0.70, 0.66, 1)')
text_button('Privacy','Agreement',(307,0,105,29),'《隐私政策》',17,'Color(0.47, 0.66, 0.83, 1)')
for name,x,w in [('TermsUnderline',181,93),('PrivacyUnderline',313,93)]:
    node(name,'ColorRect','Agreement',(x,24,w,1),'mouse_filter = 2\ncolor = Color(0.39, 0.55, 0.72, 0.9)')
text_button('AgeNotice','.',(324,1219,102,36),'适龄提示',18,'Color(0.64, 0.61, 0.53, 1)')
for name,x in [('AgeDividerLeft',222),('AgeDividerRight',438)]:
    node(name,'ColorRect','.',(x,1237,89,1),'mouse_filter = 2\ncolor = Color(0.53, 0.49, 0.41, 0.55)')
    node(name+'Tip','ColorRect','.',((310 if x==222 else 438),1236,3,3),'mouse_filter = 2\ncolor = Color(0.62, 0.57, 0.46, 0.8)')

scene = f'[gd_scene load_steps={len(ext)+len(sub)+1} format=3]\n\n' + '\n\n'.join(ext+sub+nodes)+'\n'
(PROJECT/'scenes'/'login.tscn').write_text(scene,encoding='utf-8')
print(f'Created login.tscn: {len(nodes)} editable nodes, fixed 750 x 1334; {len(files)} original PNG assets.')
