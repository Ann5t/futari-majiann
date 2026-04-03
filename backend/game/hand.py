"""
Hand management: closed tiles, melds, discards, draw/discard operations,
and call (chi/pon/kan) validations.
"""

from __future__ import annotations
from game.tiles import tile_type, is_suit, suit_of, number_of, ids_of_type, to_34_array
from game.melds import Meld, MeldType


class Hand:
    def __init__(self):
        self.closed: list[int] = []   # closed hand tile IDs
        self.melds: list[Meld] = []   # open/closed melds
        self.discards: list[int] = [] # tiles discarded by this player (牌河)
        self.hidden_discards: list[int] = [] # concealed discards that should not be shown to either player
        self.draw_tile: int | None = None  # last drawn tile (摸牌)

    def init_deal(self, tiles: list[int]):
        """Set initial dealt tiles."""
        self.closed = sorted(tiles, key=tile_type)
        self.melds = []
        self.discards = []
        self.hidden_discards = []
        self.draw_tile = None

    def add_draw(self, tile_id: int):
        """Add a drawn tile to hand."""
        self.draw_tile = tile_id
        self.closed.append(tile_id)
        self.closed.sort(key=tile_type)

    @property
    def all_discards(self) -> list[int]:
        return self.discards + self.hidden_discards

    def discard(self, tile_id: int, hidden: bool = False) -> int:
        """Discard a tile from hand. Returns the discarded tile ID."""
        if tile_id not in self.closed:
            raise ValueError(f"Tile {tile_id} not in hand")
        self.closed.remove(tile_id)
        if hidden:
            self.hidden_discards.append(tile_id)
        else:
            self.discards.append(tile_id)
        self.draw_tile = None
        return tile_id

    @property
    def is_open(self) -> bool:
        return any(m.is_open for m in self.melds)

    @property
    def closed_tile_types_34(self) -> list[int]:
        return to_34_array(self.closed)

    @property
    def all_tile_types_34(self) -> list[int]:
        """34-array including meld tiles."""
        all_ids = list(self.closed)
        for m in self.melds:
            all_ids.extend(m.tiles)
        return to_34_array(all_ids)

    # --- Call validations ---

    def can_chi(self, discard_tile: int) -> list[list[int]]:
        """Return possible chi combinations using discarded tile.
        
        Each combination is [tile1, tile2] from closed hand that
        form a sequence with discard_tile.
        """
        dt = tile_type(discard_tile)
        if not is_suit(dt):
            return []

        suit = suit_of(dt)
        num = number_of(dt)
        counts = self.closed_tile_types_34
        results = []

        # Possible sequences: (num-2,num-1,num), (num-1,num,num+1), (num,num+1,num+2)
        for start_num in range(max(1, num - 2), min(7, num) + 1):
            needed = []
            for n in range(start_num, start_num + 3):
                if n == num:
                    continue
                tt = suit * 9 + (n - 1)
                if counts[tt] == 0:
                    break
                needed.append(tt)
            else:
                # Find actual tile IDs from closed hand
                tile_ids = []
                used = set()
                for tt in needed:
                    for tid in self.closed:
                        if tile_type(tid) == tt and tid not in used:
                            tile_ids.append(tid)
                            used.add(tid)
                            break
                if len(tile_ids) == len(needed):
                    results.append(tile_ids)

        return results

    def can_pon(self, discard_tile: int) -> list[int] | None:
        """Return 2 tile IDs from closed hand for pon, or None."""
        dt = tile_type(discard_tile)
        matching = [t for t in self.closed if tile_type(t) == dt]
        if len(matching) >= 2:
            return matching[:2]
        return None

    def can_minkan(self, discard_tile: int) -> list[int] | None:
        """Return 3 tile IDs from closed hand for open kan, or None."""
        dt = tile_type(discard_tile)
        matching = [t for t in self.closed if tile_type(t) == dt]
        if len(matching) >= 3:
            return matching[:3]
        return None

    def can_ankan(self) -> list[list[int]]:
        """Return list of possible ankan groups (4 tile IDs each)."""
        counts = self.closed_tile_types_34
        results = []
        for tt in range(34):
            if counts[tt] == 4:
                group = [t for t in self.closed if tile_type(t) == tt]
                results.append(group)
        return results

    def can_kakan(self) -> list[tuple[Meld, int]]:
        """Return list of (existing pon meld, additional tile) for kakan."""
        results = []
        for meld in self.melds:
            if meld.meld_type == MeldType.PON:
                tt = tile_type(meld.tiles[0])
                for t in self.closed:
                    if tile_type(t) == tt:
                        results.append((meld, t))
                        break
        return results

    def do_chi(self, own_tiles: list[int], called_tile: int):
        """Execute chi: remove own_tiles from closed, add meld."""
        for t in own_tiles:
            self.closed.remove(t)
        all_tiles = sorted(own_tiles + [called_tile], key=tile_type)
        self.melds.append(Meld(MeldType.CHI, all_tiles, called_tile=called_tile))

    def do_pon(self, own_tiles: list[int], called_tile: int):
        """Execute pon."""
        for t in own_tiles:
            self.closed.remove(t)
        all_tiles = own_tiles + [called_tile]
        self.melds.append(Meld(MeldType.PON, all_tiles, called_tile=called_tile))

    def do_minkan(self, own_tiles: list[int], called_tile: int):
        """Execute open kan (大明杠)."""
        for t in own_tiles:
            self.closed.remove(t)
        all_tiles = own_tiles + [called_tile]
        self.melds.append(Meld(MeldType.MINKAN, all_tiles, called_tile=called_tile))

    def do_ankan(self, tiles: list[int]):
        """Execute closed kan (暗杠)."""
        for t in tiles:
            self.closed.remove(t)
        self.melds.append(Meld(MeldType.ANKAN, tiles, called_tile=None))

    def do_kakan(self, meld: Meld, extra_tile: int):
        """Execute added kan (加杠): upgrade pon to kan."""
        self.closed.remove(extra_tile)
        meld.tiles.append(extra_tile)
        meld.meld_type = MeldType.KAKAN

    def to_dict(self, hide_tiles: bool = False) -> dict:
        """Serialize. If hide_tiles, closed hand is hidden (opponent view)."""
        return {
            "closed": [] if hide_tiles else self.closed,
            "closed_count": len(self.closed),
            "melds": [m.to_dict() for m in self.melds],
            "discards": self.discards,
            "draw_tile": None if hide_tiles else self.draw_tile,
        }
