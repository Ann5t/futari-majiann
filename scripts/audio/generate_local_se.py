#!/usr/bin/env python3
import argparse
import math
import random
import struct
import wave
from pathlib import Path


SAMPLE_RATE = 44100
PEAK = 32767


def exp_env(index: int, attack_samples: int, decay_samples: int) -> float:
    if index < attack_samples:
        return index / max(1, attack_samples)
    return math.exp(-(index - attack_samples) / max(1, decay_samples))


def one_pole_lowpass(signal, alpha: float):
    output = []
    previous = 0.0
    for sample in signal:
        previous += alpha * (sample - previous)
        output.append(previous)
    return output


def soft_clip(value: float) -> float:
    return math.tanh(value * 1.35) / math.tanh(1.35)


def normalize(signal, peak: float):
    max_abs = max(abs(sample) for sample in signal) or 1.0
    scale = peak / max_abs
    return [sample * scale for sample in signal]


def write_stereo_wav(path: Path, left, right):
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), 'wb') as wav_file:
        wav_file.setnchannels(2)
        wav_file.setsampwidth(2)
        wav_file.setframerate(SAMPLE_RATE)
        frames = bytearray()
        for left_sample, right_sample in zip(left, right):
            frames.extend(struct.pack('<h', int(max(-1.0, min(1.0, left_sample)) * PEAK)))
            frames.extend(struct.pack('<h', int(max(-1.0, min(1.0, right_sample)) * PEAK)))
        wav_file.writeframes(frames)


def generate_discard(duration_seconds: float = 0.084):
    sample_count = int(SAMPLE_RATE * duration_seconds)
    attack = int(0.0015 * SAMPLE_RATE)
    transient_decay = int(0.005 * SAMPLE_RATE)
    body_decay = int(0.030 * SAMPLE_RATE)
    tail_decay = int(0.018 * SAMPLE_RATE)

    bright_noise = [random.uniform(-1.0, 1.0) for _ in range(sample_count)]
    dull_noise = one_pole_lowpass(bright_noise, 0.08)

    left = []
    right = []
    for index in range(sample_count):
        time_point = index / SAMPLE_RATE
        transient = bright_noise[index] * 0.72 * exp_env(index, attack, transient_decay)
        body = dull_noise[index] * exp_env(index, attack, body_decay)
        tone_a = math.sin(2.0 * math.pi * 300.0 * time_point)
        tone_b = math.sin(2.0 * math.pi * 470.0 * time_point + 0.25)
        tone_c = math.sin(2.0 * math.pi * 760.0 * time_point + 0.4)
        tone = (0.88 * tone_a + 0.38 * tone_b + 0.12 * tone_c) * exp_env(index, attack, body_decay)

        secondary_contact_offset = int(0.015 * SAMPLE_RATE)
        secondary = 0.0
        if index >= secondary_contact_offset:
            secondary_index = index - secondary_contact_offset
            secondary_tone = math.sin(2.0 * math.pi * 240.0 * (secondary_index / SAMPLE_RATE))
            secondary = (
                dull_noise[secondary_index] * 0.16 + secondary_tone * 0.22
            ) * exp_env(secondary_index, 1, tail_decay)

        mono = 0.20 * transient + 0.52 * body + 0.62 * tone + secondary
        mono = soft_clip(mono)
        left.append(mono * 0.99)
        right.append(mono * 0.96)

    left = one_pole_lowpass(left, 0.18)
    right = one_pole_lowpass(right, 0.18)
    left = normalize(left, 0.90)
    right = normalize(right, 0.87)
    return left, right


def generate_select(duration_seconds: float = 0.026):
    sample_count = int(SAMPLE_RATE * duration_seconds)
    attack = int(0.0004 * SAMPLE_RATE)
    click_decay = int(0.0022 * SAMPLE_RATE)
    tone_decay = int(0.0075 * SAMPLE_RATE)

    base_noise = [random.uniform(-1.0, 1.0) for _ in range(sample_count)]
    filtered_noise = one_pole_lowpass(base_noise, 0.38)

    left = []
    right = []
    for index in range(sample_count):
        time_point = index / SAMPLE_RATE
        click = (base_noise[index] - filtered_noise[index]) * exp_env(index, attack, click_decay)
        tone_a = math.sin(2.0 * math.pi * 920.0 * time_point)
        tone_b = math.sin(2.0 * math.pi * 1420.0 * time_point + 0.2)
        tone = (0.72 * tone_a + 0.30 * tone_b) * exp_env(index, attack, tone_decay)
        mono = 0.22 * click + 0.54 * tone
        mono = soft_clip(mono)
        left.append(mono * 0.97)
        right.append(mono * 0.93)

    left = normalize(left, 0.74)
    right = normalize(right, 0.70)
    return left, right


def main():
    parser = argparse.ArgumentParser(description='Generate local fallback short SE assets for futari-majiann.')
    parser.add_argument(
        '--output-dir',
        default='frontend/assets/audio/se',
        help='Directory where SE wav files will be written.',
    )
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[2]
    output_dir = repo_root / args.output_dir

    discard_left, discard_right = generate_discard()
    write_stereo_wav(output_dir / 'se_tile_discard_01.wav', discard_left, discard_right)

    select_left, select_right = generate_select()
    write_stereo_wav(output_dir / 'se_ui_click_soft_01.wav', select_left, select_right)

    print('generated: se_tile_discard_01.wav, se_ui_click_soft_01.wav')


if __name__ == '__main__':
    main()