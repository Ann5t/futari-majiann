#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw


DEFAULT_ORDER = [
    *[f'{value}m' for value in range(1, 10)],
    *[f'{value}p' for value in range(1, 10)],
    *[f'{value}s' for value in range(1, 10)],
    'east', 'south', 'west', 'north', 'haku', 'hatsu', 'chun',
]


def load_manifest(path: Path | None):
    if not path:
        return {}
    return json.loads(path.read_text(encoding='utf-8'))


def crop_box_for_index(index: int, args):
    column = index % args.cols
    row = index // args.cols
    left = args.offset_x + column * (args.tile_width + args.gap_x)
    top = args.offset_y + row * (args.tile_height + args.gap_y)
    return (left, top, left + args.tile_width, top + args.tile_height)


def main():
    parser = argparse.ArgumentParser(description='Slice a riichi mahjong tile sprite sheet into individual tile images.')
    parser.add_argument('--input', required=True, help='Input sprite sheet path')
    parser.add_argument('--output-dir', required=True, help='Directory for sliced tiles')
    parser.add_argument('--manifest', help='Optional JSON manifest with per-tile boxes')
    parser.add_argument('--cols', type=int, default=6, help='Grid columns')
    parser.add_argument('--rows', type=int, default=6, help='Grid rows')
    parser.add_argument('--tile-width', type=int, required=True, help='Single tile width in pixels')
    parser.add_argument('--tile-height', type=int, required=True, help='Single tile height in pixels')
    parser.add_argument('--offset-x', type=int, default=0, help='Grid start X')
    parser.add_argument('--offset-y', type=int, default=0, help='Grid start Y')
    parser.add_argument('--gap-x', type=int, default=0, help='Horizontal gap between cells')
    parser.add_argument('--gap-y', type=int, default=0, help='Vertical gap between cells')
    parser.add_argument('--format', default='png', choices=['png', 'jpg', 'jpeg', 'webp'], help='Output image format')
    parser.add_argument('--preview', help='Optional path for a grid preview image')
    parser.add_argument('--overwrite', action='store_true', help='Overwrite existing files')
    args = parser.parse_args()

    input_path = Path(args.input).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    image = Image.open(input_path).convert('RGBA')
    manifest = load_manifest(Path(args.manifest).resolve() if args.manifest else None)

    preview = image.copy()
    preview_draw = ImageDraw.Draw(preview)

    boxes = manifest.get('boxes') or {}
    for index, name in enumerate(DEFAULT_ORDER):
        if name in boxes:
            left, top, right, bottom = boxes[name]
            box = (int(left), int(top), int(right), int(bottom))
        else:
            box = crop_box_for_index(index, args)

        preview_draw.rectangle(box, outline=(255, 0, 0, 255), width=2)
        preview_draw.text((box[0] + 4, box[1] + 4), name, fill=(255, 0, 0, 255))

        output_path = output_dir / f'{name}.{args.format}'
        if output_path.exists() and not args.overwrite:
            raise SystemExit(f'{output_path} already exists, pass --overwrite to replace it')

        tile = image.crop(box)
        save_format = 'JPEG' if args.format in ('jpg', 'jpeg') else args.format.upper()
        if save_format == 'JPEG':
            tile = tile.convert('RGB')
        tile.save(output_path, format=save_format)

    if args.preview:
        preview_path = Path(args.preview).resolve()
        preview_path.parent.mkdir(parents=True, exist_ok=True)
        preview.save(preview_path)

    print(json.dumps({
        'ok': True,
        'input': str(input_path),
        'output_dir': str(output_dir),
        'count': len(DEFAULT_ORDER),
        'preview': str(Path(args.preview).resolve()) if args.preview else None,
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()