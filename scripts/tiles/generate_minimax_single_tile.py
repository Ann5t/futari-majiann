#!/usr/bin/env python3
import argparse
import json
import os
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path


API_URL = 'https://api.minimaxi.com/v1/image_generation'
DEFAULT_MODEL = 'image-01'
DEFAULT_SIZE = '1024x1024'
DEFAULT_BACKGROUND = 'pure white'
TILE_ORDER = [
    *[f'{value}m' for value in range(1, 10)],
    *[f'{value}p' for value in range(1, 10)],
    *[f'{value}s' for value in range(1, 10)],
    'east', 'south', 'west', 'north', 'haku', 'hatsu', 'chun',
]
KANJI_NUMERALS = {
    1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '七', 8: '八', 9: '九',
}
HONOR_GLYPHS = {
    'east': ('東', 'deep black'),
    'south': ('南', 'deep black'),
    'west': ('西', 'deep black'),
    'north': ('北', 'deep black'),
    'hatsu': ('發', 'jade green'),
    'chun': ('中', 'rich vermilion red'),
}
PIN_LAYOUTS = {
    1: 'exactly one large central circular pip',
    2: 'exactly two circular pips aligned vertically',
    3: 'exactly three circular pips arranged top, center, bottom',
    4: 'exactly four circular pips arranged in a balanced 2 by 2 grid',
    5: 'exactly five circular pips arranged as four corners plus one center pip',
    6: 'exactly six circular pips arranged as two vertical columns of three',
    7: 'exactly seven circular pips arranged as three upper pips, one center pip, and three lower pips in balanced symmetry',
    8: 'exactly eight circular pips arranged as two balanced vertical columns of four',
    9: 'exactly nine circular pips arranged in a 3 by 3 grid',
}
SOU_LAYOUTS = {
    1: 'a single distinctive green bamboo or bird-inspired souzu motif centered on the tile',
    2: 'exactly two bamboo-stick motifs aligned vertically',
    3: 'exactly three bamboo-stick motifs arranged top, center, bottom',
    4: 'exactly four bamboo-stick motifs arranged in a balanced 2 by 2 grid',
    5: 'exactly five bamboo-stick motifs arranged as four corners plus one center motif',
    6: 'exactly six bamboo-stick motifs arranged as two vertical columns of three',
    7: 'exactly seven bamboo-stick motifs arranged as three upper motifs, one center motif, and three lower motifs in balanced symmetry',
    8: 'exactly eight bamboo-stick motifs arranged as two balanced vertical columns of four',
    9: 'exactly nine bamboo-stick motifs arranged in a 3 by 3 grid',
}
NEGATIVE_PROMPT = (
    'multiple tiles, two tiles, stacked tiles, overlapping tiles, cropped tile, partial tile, '
    'perspective view, angled view, tilted view, isometric view, hand, fingers, table, cloth, tray, '
    'rack, dice, chips, background scene, patterned background, extra objects, extra symbols, extra glyphs, '
    'extra letters, extra numbers, tiny text, watermark, logo, signature, seal, caption, subtitles, '
    'frame border outside the tile, low legibility, off-center artwork, asymmetrical layout, distorted proportions, '
    'blur, low resolution'
)


def request_generation(api_key: str, prompt: str, model: str, size: str):
    payload = {
        'model': model,
        'prompt': prompt,
        'size': size,
    }
    request = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode('utf-8'),
        method='POST',
        headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {api_key}',
        },
    )
    with urllib.request.urlopen(request, timeout=240, context=ssl.create_default_context()) as response:
        result = json.loads(response.read().decode('utf-8'))
    base = result.get('base_resp') or {}
    if base.get('status_code') != 0:
        raise RuntimeError(f"MiniMax error: {base.get('status_code')} {base.get('status_msg')}")
    image_urls = ((result.get('data') or {}).get('image_urls') or [])
    if not image_urls:
        raise RuntimeError('MiniMax returned no image URL')
    return image_urls[0], result


def download_file(url: str, destination: Path):
    destination.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=240, context=ssl.create_default_context()) as response:
        destination.write_bytes(response.read())


def build_man_prompt(tile_name: str, value: int, background: str):
    numeral = KANJI_NUMERALS[value]
    return (
        'A single original Japanese mahjong tile face, one tile only, front orthographic view, perfectly face-on, '
        'centered composition, full tile visible, no cropping, isolated on a plain solid '
        f'{background} background. Clean ivory-white ceramic tile with subtle glossy glaze, gentle beveled edges, '
        'premium game-piece rendering, no external shadow. The tile face contains only two centered calligraphic glyphs: '
        f'the main glyph "{numeral}" and the smaller suit glyph "萬". The main glyph is elegant, bold, clearly legible, '
        'painted in deep vermilion red ink. The smaller 萬 glyph is directly beneath it, also in deep vermilion red ink. '
        'No corner numbers, no extra marks, no tiny text, no seals, no annotations. '
        f'Negative constraints: {NEGATIVE_PROMPT}'
    )


def build_pin_prompt(tile_name: str, value: int, background: str):
    layout = PIN_LAYOUTS[value]
    return (
        'A single original Japanese mahjong pinzu tile face, one tile only, front orthographic view, perfectly face-on, '
        'centered composition, full tile visible, no cropping, isolated on a plain solid '
        f'{background} background. Clean ivory-white ceramic tile with subtle glossy glaze, gentle beveled edges, premium game-piece rendering. '
        f'The tile face shows {layout}. Use premium riichi mahjong style circular pips in balanced symmetry, with refined blue, green, and occasional red accents when appropriate. '
        'No letters, no kanji, no corner numbers, no small suit labels, no decorative stamps, no extra symbols. '
        f'Negative constraints: {NEGATIVE_PROMPT}'
    )


def build_sou_prompt(tile_name: str, value: int, background: str):
    layout = SOU_LAYOUTS[value]
    return (
        'A single original Japanese mahjong souzu tile face, one tile only, front orthographic view, perfectly face-on, '
        'centered composition, full tile visible, no cropping, isolated on a plain solid '
        f'{background} background. Clean ivory-white ceramic tile with subtle glossy glaze, gentle beveled edges, premium game-piece rendering. '
        f'The tile face shows {layout}. Use refined green bamboo-stick motifs with balanced spacing and strong readability. '
        'No letters, no kanji, no corner numbers, no small suit labels, no decorative stamps, no extra symbols. '
        f'Negative constraints: {NEGATIVE_PROMPT}'
    )


def build_honor_prompt(tile_name: str, background: str):
    glyph, color = HONOR_GLYPHS[tile_name]
    return (
        'A single original Japanese mahjong honor tile face, one tile only, front orthographic view, perfectly face-on, '
        'centered composition, full tile visible, no cropping, isolated on a plain solid '
        f'{background} background. Smooth ivory-white ceramic tile with subtle gloss, precise beveled edges, premium tabletop rendering. '
        f'The tile face contains only one centered large glyph: "{glyph}", painted in {color} ink, with clean brushstroke structure, balanced spacing, and strong legibility. '
        f'The only readable text on the tile is "{glyph}". No extra small text, no seals, no additional characters, no corner numbers. '
        f'Negative constraints: {NEGATIVE_PROMPT}'
    )


def build_haku_prompt(background: str):
    return (
        'A single original Japanese mahjong white dragon tile face, one tile only, front orthographic view, perfectly face-on, '
        'centered composition, full tile visible, no cropping, isolated on a plain solid '
        f'{background} background. Clean ivory-white ceramic tile, premium glossy glaze, subtle beveled edges. '
        'The tile face is intentionally blank: no text, no glyphs, no readable marks. Include only a very subtle centered inner frame in pale cyan or very light blue, minimal and abstract. '
        'No letters, no runes, no logo, no corner numbers, no additional symbols. '
        f'Negative constraints: {NEGATIVE_PROMPT}'
    )


def build_prompt(tile_name: str, background: str):
    if tile_name.endswith('m') and tile_name[:-1].isdigit():
        return build_man_prompt(tile_name, int(tile_name[:-1]), background)
    if tile_name.endswith('p') and tile_name[:-1].isdigit():
        return build_pin_prompt(tile_name, int(tile_name[:-1]), background)
    if tile_name.endswith('s') and tile_name[:-1].isdigit():
        return build_sou_prompt(tile_name, int(tile_name[:-1]), background)
    if tile_name == 'haku':
        return build_haku_prompt(background)
    if tile_name in HONOR_GLYPHS:
        return build_honor_prompt(tile_name, background)
    raise ValueError(f'Unsupported tile name: {tile_name}')


def parse_tiles(raw_tiles: str):
    if raw_tiles.strip().lower() == 'all':
        return TILE_ORDER
    selected = [tile.strip() for tile in raw_tiles.split(',') if tile.strip()]
    unknown = [tile for tile in selected if tile not in TILE_ORDER]
    if unknown:
        raise ValueError(f'Unknown tiles: {", ".join(unknown)}')
    return selected


def main():
    parser = argparse.ArgumentParser(description='Generate original single riichi mahjong tiles with MiniMax.')
    parser.add_argument('--tiles', required=True, help='Comma separated tiles like 1m,east,haku or all')
    parser.add_argument('--model', default=DEFAULT_MODEL, help='MiniMax image model name')
    parser.add_argument('--size', default=DEFAULT_SIZE, help='Output size, e.g. 1024x1024')
    parser.add_argument('--background', default=DEFAULT_BACKGROUND, help='Background description for prompting')
    parser.add_argument('--out-dir', default='generated/tiles/single', help='Output image directory')
    parser.add_argument('--meta-dir', default='generated/tiles/single-meta', help='Output metadata directory')
    parser.add_argument('--dry-run', action='store_true', help='Print prompts without calling the API')
    args = parser.parse_args()

    api_key = os.environ.get('MINIMAX_API_KEY', '').strip()
    if not args.dry_run and not api_key:
        print('MINIMAX_API_KEY is required unless --dry-run is used.', file=sys.stderr)
        sys.exit(1)

    repo_root = Path(__file__).resolve().parents[2]
    out_dir = repo_root / args.out_dir
    meta_dir = repo_root / args.meta_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    meta_dir.mkdir(parents=True, exist_ok=True)

    tiles = parse_tiles(args.tiles)
    planned = []
    for tile_name in tiles:
        planned.append({'tile': tile_name, 'prompt': build_prompt(tile_name, args.background)})

    if args.dry_run:
        print(json.dumps(planned, ensure_ascii=False, indent=2))
        return

    for index, item in enumerate(planned, start=1):
        tile_name = item['tile']
        prompt = item['prompt']
        print(f'[{index}/{len(planned)}] Generating {tile_name} ...')
        try:
            image_url, result = request_generation(api_key, prompt, args.model, args.size)
            image_path = out_dir / f'{tile_name}.jpg'
            meta_path = meta_dir / f'{tile_name}.json'
            download_file(image_url, image_path)
            meta_path.write_text(json.dumps({
                'ok': True,
                'tile': tile_name,
                'model': args.model,
                'prompt': prompt,
                'image_url': image_url,
                'file_path': str(image_path.relative_to(repo_root)),
                'request_id': result.get('id'),
                'raw_response': result,
            }, ensure_ascii=False, indent=2), encoding='utf-8')
            print(json.dumps({'tile': tile_name, 'image': str(image_path), 'meta': str(meta_path)}, ensure_ascii=False))
        except urllib.error.HTTPError as error:
            body = error.read().decode('utf-8', 'ignore')
            raise SystemExit(f'HTTP {error.code} for {tile_name}: {body}')
        except Exception as error:
            raise SystemExit(f'{tile_name}: {error}')


if __name__ == '__main__':
    main()