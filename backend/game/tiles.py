"""
Tile representation for Japanese Mahjong.

Uses 136-tile format compatible with the `mahjong` library.
Tile IDs 0-135 map to 34 unique tile types × 4 copies each.

Tile type index (0-33):
    0-8:   Man (万子) 1m-9m
    9-17:  Pin (筒子) 1p-9p
    18-26: Sou (索子) 1s-9s
    27-33: Honors  东(27) 南(28) 西(29) 北(30) 白(31) 发(32) 中(33)

Red dora follows the `mahjong` library's standard 136-format ids:
    16 = 0m, 52 = 0p, 88 = 0s
"""

from __future__ import annotations

SUIT_NAMES = ["m", "p", "s"]
HONOR_NAMES = {27: "东", 28: "南", 29: "西", 30: "北", 31: "白", 32: "发", 33: "中"}
HONOR_WIND = {"east": 27, "south": 28, "west": 29, "north": 30}
HONOR_DRAGON = {"haku": 31, "hatsu": 32, "chun": 33}

RED_DORA_BY_TYPE = {
    4: 16,   # 0m
    13: 52,  # 0p
    22: 88,  # 0s
}
RED_DORA_IDS = set(RED_DORA_BY_TYPE.values())

NUM_TILE_TYPES = 34
NUM_TILES = 136


def tile_type(tile_id: int) -> int:
    """Get tile type index (0-33) from 136-format tile ID."""
    return tile_id // 4


def is_red_dora(tile_id: int) -> bool:
    """Whether a 136-format tile id is one of the three standard red fives."""
    return tile_id in RED_DORA_IDS


def red_dora_id_for_type(tt: int) -> int | None:
    """Return the red-dora tile id for a 5-tile type, else None."""
    return RED_DORA_BY_TYPE.get(tt)


def tile_name(tile_id: int) -> str:
    """Human-readable name, e.g. '1m', '東'."""
    tt = tile_type(tile_id)
    if is_red_dora(tile_id):
        if tt < 9:
            return '0m'
        elif tt < 18:
            return '0p'
        elif tt < 27:
            return '0s'
    if tt < 9:
        return f"{tt + 1}m"
    elif tt < 18:
        return f"{tt - 9 + 1}p"
    elif tt < 27:
        return f"{tt - 18 + 1}s"
    else:
        return HONOR_NAMES[tt]


def tile_type_from_str(s: str) -> int:
    """Parse '1m', '東', etc. to tile type index (0-33)."""
    if len(s) == 2 and s[1] in "mps":
        num = int(s[0])
        if num == 0:
            return SUIT_NAMES.index(s[1]) * 9 + 4
        suit_idx = SUIT_NAMES.index(s[1])
        return suit_idx * 9 + (num - 1)
    for tt, name in HONOR_NAMES.items():
        if s == name:
            return tt
    raise ValueError(f"Unknown tile string: {s}")


def tile_type_name(tt: int) -> str:
    """Tile type index to human-readable name."""
    if tt < 9:
        return f"{tt + 1}m"
    elif tt < 18:
        return f"{tt - 9 + 1}p"
    elif tt < 27:
        return f"{tt - 18 + 1}s"
    else:
        return HONOR_NAMES[tt]


def all_tile_ids() -> list[int]:
    """Return list of all 136 tile IDs."""
    return list(range(NUM_TILES))


def is_suit(tt: int) -> bool:
    return tt < 27


def is_honor(tt: int) -> bool:
    return tt >= 27


def is_wind(tt: int) -> bool:
    return 27 <= tt <= 30


def is_dragon(tt: int) -> bool:
    return 31 <= tt <= 33


def suit_of(tt: int) -> int | None:
    """Return suit index (0=man, 1=pin, 2=sou) or None for honors."""
    if tt < 27:
        return tt // 9
    return None


def number_of(tt: int) -> int | None:
    """Return number (1-9) for suited tiles, None for honors."""
    if tt < 27:
        return (tt % 9) + 1
    return None


def ids_of_type(tt: int) -> list[int]:
    """Return the 4 tile IDs for a given tile type."""
    tile_ids = [tt * 4, tt * 4 + 1, tt * 4 + 2, tt * 4 + 3]
    red_id = red_dora_id_for_type(tt)
    if red_id is None:
        return tile_ids
    return [tile_id for tile_id in tile_ids if tile_id != red_id] + [red_id]


def to_34_array(tile_ids: list[int]) -> list[int]:
    """Convert list of 136-format IDs to 34-element count array."""
    counts = [0] * NUM_TILE_TYPES
    for tid in tile_ids:
        counts[tile_type(tid)] += 1
    return counts


def from_34_array(counts: list[int]) -> list[int]:
    """Convert 34-element count array back to 136-format IDs (using lowest available)."""
    result = []
    for tt in range(NUM_TILE_TYPES):
        tile_ids = ids_of_type(tt)
        for index in range(counts[tt]):
            result.append(tile_ids[index])
    return result


def tiles_to_mpsz(tile_ids: list[int]) -> str:
    """Convert tile IDs to mpsz notation, e.g. '123m456p789s11z'."""
    suits: dict[str, list[int]] = {"m": [], "p": [], "s": [], "z": []}
    for tid in sorted(tile_ids, key=tile_type):
        tt = tile_type(tid)
        if tt < 9:
            suits["m"].append(0 if is_red_dora(tid) else tt + 1)
        elif tt < 18:
            suits["p"].append(0 if is_red_dora(tid) else tt - 9 + 1)
        elif tt < 27:
            suits["s"].append(0 if is_red_dora(tid) else tt - 18 + 1)
        else:
            suits["z"].append(tt - 27 + 1)
    parts = []
    for suit in ["m", "p", "s", "z"]:
        if suits[suit]:
            parts.append("".join(str(n) for n in suits[suit]) + suit)
    return "".join(parts)
