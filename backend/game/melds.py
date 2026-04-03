"""
Meld (副露/面子) definitions for chi, pon, kan.
"""

from __future__ import annotations
from enum import Enum
from game.tiles import tile_type


class MeldType(str, Enum):
    CHI = "chi"       # 吃
    PON = "pon"       # 碰
    MINKAN = "minkan"  # 明杠 (大明杠)
    ANKAN = "ankan"    # 暗杠
    KAKAN = "kakan"    # 加杠 (小明杠)


class Meld:
    def __init__(self, meld_type: MeldType, tiles: list[int], called_tile: int | None = None):
        self.meld_type = meld_type
        self.tiles = tiles  # all tile IDs in the meld
        self.called_tile = called_tile  # the tile taken from opponent (None for ankan)

    @property
    def is_open(self) -> bool:
        return self.meld_type != MeldType.ANKAN

    @property
    def tile_types(self) -> list[int]:
        return [tile_type(t) for t in self.tiles]

    def to_dict(self) -> dict:
        return {
            "type": self.meld_type.value,
            "tiles": self.tiles,
            "called_tile": self.called_tile,
        }

    @staticmethod
    def from_dict(d: dict) -> "Meld":
        return Meld(
            meld_type=MeldType(d["type"]),
            tiles=d["tiles"],
            called_tile=d.get("called_tile"),
        )
