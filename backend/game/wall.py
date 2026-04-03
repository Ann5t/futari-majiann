"""
Wall management: shuffling, dealing, drawing.
Handles the tile wall, dead wall (王牌), and dora indicators.
"""

from __future__ import annotations
import secrets
from game.tiles import all_tile_ids, tile_type, NUM_TILE_TYPES

DEAD_WALL_SIZE = 14  # 王牌: 4 dora indicators + 4 uradora + 4 rinshan + 2 extra
RINSHAN_COUNT = 4


class Wall:
    def __init__(self):
        self.tiles: list[int] = []
        self.dead_wall: list[int] = []
        self.dora_indicators: list[int] = []
        self.draw_pos: int = 0
        self.rinshan_pos: int = 0
        self.kan_count: int = 0

    def setup(self):
        """Shuffle and set up wall for a new round."""
        tiles = all_tile_ids()
        # Fisher-Yates shuffle with cryptographic randomness
        for i in range(len(tiles) - 1, 0, -1):
            j = secrets.randbelow(i + 1)
            tiles[i], tiles[j] = tiles[j], tiles[i]

        # Dead wall = last 14 tiles
        self.dead_wall = tiles[-DEAD_WALL_SIZE:]
        self.tiles = tiles[:-DEAD_WALL_SIZE]
        self.draw_pos = 0
        self.rinshan_pos = 0
        self.kan_count = 0

        # First dora indicator is dead_wall[4] (5th tile of dead wall)
        self.dora_indicators = [self.dead_wall[4]]

    def deal(self, count: int) -> list[int]:
        """Deal `count` tiles from the wall."""
        dealt = self.tiles[self.draw_pos : self.draw_pos + count]
        self.draw_pos += count
        return dealt

    def draw(self) -> int | None:
        """Draw one tile from the wall. Returns None if exhausted."""
        if self.draw_pos >= len(self.tiles):
            return None
        tile = self.tiles[self.draw_pos]
        self.draw_pos += 1
        return tile

    def draw_rinshan(self) -> int | None:
        """Draw from dead wall (rinshan / 岭上) for kan replacement."""
        if self.rinshan_pos >= RINSHAN_COUNT:
            return None
        tile = self.dead_wall[self.rinshan_pos]
        self.rinshan_pos += 1
        self.kan_count += 1
        # Reveal new dora indicator
        if self.kan_count <= 4:
            next_dora_idx = 4 + self.kan_count
            if next_dora_idx < len(self.dead_wall):
                self.dora_indicators.append(self.dead_wall[next_dora_idx])
        return tile

    @property
    def remaining(self) -> int:
        """Number of drawable tiles remaining in the wall."""
        return len(self.tiles) - self.draw_pos

    def get_dora_tiles(self) -> list[int]:
        """Get the actual dora tile types from indicators.
        
        Indicator → dora mapping:
          1m→2m, ..., 8m→9m, 9m→1m  (same for pin, sou)
          東→南→西→北→東
          白→發→中→白
        """
        dora_types = []
        for indicator_id in self.dora_indicators:
            tt = tile_type(indicator_id)
            if tt < 27:
                suit_start = (tt // 9) * 9
                dora_types.append(suit_start + (tt - suit_start + 1) % 9)
            elif tt <= 30:  # winds
                dora_types.append(27 + (tt - 27 + 1) % 4)
            else:  # dragons
                dora_types.append(31 + (tt - 31 + 1) % 3)
        return dora_types

    def get_uradora_indicators(self) -> list[int]:
        """Return ura-dora indicators matching the currently revealed dora count."""
        indicator_count = len(self.dora_indicators)
        start = 9
        end = min(len(self.dead_wall), start + indicator_count)
        return self.dead_wall[start:end]

    def to_dict(self) -> dict:
        """Serializable state (public info only)."""
        return {
            "remaining": self.remaining,
            "dora_indicators": self.dora_indicators,
            "dora_tiles": self.get_dora_tiles(),
        }
