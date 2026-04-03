#!/usr/bin/env python3
import argparse
import json
import os
import ssl
import sys
import tempfile
import urllib.error
import urllib.request
import wave
from pathlib import Path

API_URL = 'https://api.minimaxi.com/v1/music_generation'
DEFAULT_MODEL = 'music-2.5'
DEFAULT_SAMPLE_RATE = 44100
DEFAULT_BITRATE = 128000
DEFAULT_FORMAT = 'wav'
SILENCE_THRESHOLD = 700


def load_specs(spec_path: Path):
    with spec_path.open('r', encoding='utf-8') as handle:
        return json.load(handle)


def filter_specs(specs, names, limit):
    selected = specs
    if names:
        wanted = {name.strip() for name in names.split(',') if name.strip()}
        selected = [spec for spec in specs if spec['name'] in wanted]
    if limit is not None:
        selected = selected[:limit]
    return selected


def request_generation(api_key: str, spec: dict, model: str):
    payload = {
        'model': model,
        'prompt': spec['prompt'],
        'lyrics': spec.get('lyrics', '[Inst]'),
        'output_format': 'url',
        'audio_setting': {
            'sample_rate': DEFAULT_SAMPLE_RATE,
            'bitrate': DEFAULT_BITRATE,
            'format': DEFAULT_FORMAT,
        },
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
        raise RuntimeError(f"MiniMax error for {spec['name']}: {base.get('status_code')} {base.get('status_msg')}")
    audio_url = ((result.get('data') or {}).get('audio'))
    if not audio_url:
        raise RuntimeError(f"MiniMax returned no audio URL for {spec['name']}")
    return audio_url, result


def download_file(url: str, destination: Path):
    destination.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=240, context=ssl.create_default_context()) as response:
        destination.write_bytes(response.read())


def read_wav_frames(path: Path):
    with wave.open(str(path), 'rb') as wav_file:
        params = wav_file.getparams()
        frames = wav_file.readframes(wav_file.getnframes())
    return params, frames


def write_wav_frames(path: Path, params, frames: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), 'wb') as wav_file:
        wav_file.setparams(params)
        wav_file.writeframes(frames)


def trim_wav_in_place(path: Path, target_seconds: float, pre_roll_seconds: float):
    params, frames = read_wav_frames(path)
    sample_width = params.sampwidth
    channels = params.nchannels
    frame_rate = params.framerate
    frame_size = sample_width * channels
    total_frames = len(frames) // frame_size

    start_frame = 0
    for idx in range(total_frames):
      offset = idx * frame_size
      frame = frames[offset: offset + frame_size]
      if any(abs(int.from_bytes(frame[i:i + sample_width], 'little', signed=True)) > SILENCE_THRESHOLD for i in range(0, len(frame), sample_width)):
          start_frame = max(0, idx - int(pre_roll_seconds * frame_rate))
          break

    keep_frames = max(1, int(target_seconds * frame_rate))
    end_frame = min(total_frames, start_frame + keep_frames)
    trimmed = frames[start_frame * frame_size:end_frame * frame_size]
    write_wav_frames(path, params, trimmed)


def ensure_parent(path_str: str, root: Path) -> Path:
    path = root / path_str
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def main():
    parser = argparse.ArgumentParser(description='Generate audio assets with MiniMax music-2.5.')
    parser.add_argument('--spec', default='scripts/audio/minimax_specs.json', help='JSON spec file path')
    parser.add_argument('--limit', type=int, default=None, help='Only generate the first N specs after filtering')
    parser.add_argument('--names', default='', help='Comma separated spec names to generate')
    parser.add_argument('--model', default=DEFAULT_MODEL, help='MiniMax model name, default music-2.5')
    parser.add_argument('--dry-run', action='store_true', help='Print planned generations without calling the API')
    args = parser.parse_args()

    api_key = os.environ.get('MINIMAX_API_KEY', '').strip()
    if not args.dry_run and not api_key:
        print('MINIMAX_API_KEY is required unless --dry-run is used.', file=sys.stderr)
        sys.exit(1)

    repo_root = Path(__file__).resolve().parents[2]
    spec_path = repo_root / args.spec
    specs = load_specs(spec_path)
    selected = filter_specs(specs, args.names, args.limit)

    if not selected:
        print('No specs selected.', file=sys.stderr)
        sys.exit(1)

    print(f'Selected {len(selected)} spec(s):')
    for spec in selected:
        print(f"- {spec['name']} -> {spec['output']}")

    if args.dry_run:
        return

    for index, spec in enumerate(selected, start=1):
        print(f'[{index}/{len(selected)}] Generating {spec["name"]} ...')
        try:
            audio_url, result = request_generation(api_key, spec, args.model)
            with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as temp_file:
                temp_path = Path(temp_file.name)
            try:
                download_file(audio_url, temp_path)
                output_path = ensure_parent(spec['output'], repo_root)
                temp_bytes = temp_path.read_bytes()
                output_path.write_bytes(temp_bytes)
                if spec.get('keep_mode') == 'trim':
                    trim_wav_in_place(
                        output_path,
                        float(spec.get('target_seconds', 1.0)),
                        float(spec.get('pre_roll_seconds', 0.02)),
                    )
                extra = result.get('extra_info') or {}
                print(f"  saved {output_path} ({extra.get('music_duration', 'unknown')} ms source)")
            finally:
                if temp_path.exists():
                    temp_path.unlink()
        except urllib.error.HTTPError as error:
            body = error.read().decode('utf-8', 'ignore')
            raise SystemExit(f'HTTP {error.code} while generating {spec["name"]}: {body}')
        except Exception as error:
            raise SystemExit(str(error))


if __name__ == '__main__':
    main()
