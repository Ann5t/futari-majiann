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
DEFAULT_PROMPT = (
    'Create one original Japanese riichi mahjong tile sprite sheet with exactly 34 unique tile faces. '
    'Use a strict 6x6 grid layout, fill the first 34 cells left-to-right top-to-bottom, leave the last 2 cells empty. '
    'Front view only, no perspective, no tilt, no overlap, equal spacing, consistent framing, plain neutral background. '
    'Premium modern riichi mahjong look, highly readable symbols, cold white ceramic tile surfaces, restrained highlights, '
    'original design not based on any existing game, no watermark, no extra props, no hands, no table.'
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


def main():
    parser = argparse.ArgumentParser(description='Generate an original riichi mahjong tile sprite sheet with MiniMax.')
    parser.add_argument('--prompt', default=DEFAULT_PROMPT, help='Prompt for the image model')
    parser.add_argument('--model', default=DEFAULT_MODEL, help='MiniMax image model name')
    parser.add_argument('--size', default=DEFAULT_SIZE, help='Output size, e.g. 1024x1024')
    parser.add_argument('--out-image', default='generated/tilesheets/minimax_tilesheet.jpg', help='Output image path')
    parser.add_argument('--out-meta', default='generated/tilesheets/minimax_tilesheet.json', help='Output metadata JSON path')
    parser.add_argument('--dry-run', action='store_true', help='Print request payload without calling the API')
    args = parser.parse_args()

    api_key = os.environ.get('MINIMAX_API_KEY', '').strip()
    if not args.dry_run and not api_key:
        print('MINIMAX_API_KEY is required unless --dry-run is used.', file=sys.stderr)
        sys.exit(1)

    repo_root = Path(__file__).resolve().parents[2]
    out_image = repo_root / args.out_image
    out_meta = repo_root / args.out_meta

    payload_preview = {
        'model': args.model,
        'prompt': args.prompt,
        'size': args.size,
    }
    if args.dry_run:
        print(json.dumps(payload_preview, ensure_ascii=False, indent=2))
        return

    try:
        image_url, result = request_generation(api_key, args.prompt, args.model, args.size)
        download_file(image_url, out_image)
        meta = {
            'ok': True,
            'model': args.model,
            'prompt': args.prompt,
            'image_url': image_url,
            'file_path': str(out_image.relative_to(repo_root)),
            'request_id': result.get('id'),
            'raw_response': result,
        }
        out_meta.parent.mkdir(parents=True, exist_ok=True)
        out_meta.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({
            'ok': True,
            'image': str(out_image),
            'meta': str(out_meta),
            'request_id': result.get('id'),
        }, ensure_ascii=False))
    except urllib.error.HTTPError as error:
        body = error.read().decode('utf-8', 'ignore')
        raise SystemExit(f'HTTP {error.code}: {body}')
    except Exception as error:
        raise SystemExit(str(error))


if __name__ == '__main__':
    main()