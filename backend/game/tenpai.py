"""
Tenpai (听牌) detection, waiting tile calculation, and furiten (振听) checking.
Uses the `mahjong` library's shanten calculator.
"""

from __future__ import annotations
from mahjong.shanten import Shanten
from game.tiles import tile_type, to_34_array, NUM_TILE_TYPES
from game.hand import Hand
from game.melds import MeldType


def shanten_number(hand: Hand) -> int:
    """Calculate shanten number for the closed portion of the hand.
    
    mahjong v2.0.0 Shanten.calculate_shanten is a static method that
    only takes the 34-array of closed tiles. With open melds, the closed
    portion has fewer tiles (3n+1 or 3n+2), and the library handles that.
    
    We disable chiitoitsu/kokushi when hand has open melds since those
    require a fully closed hand of 13+ tiles.
    
    -1 = complete (agari)
     0 = tenpai
     1 = iishanten
     etc.
    """
    tiles_34 = hand.closed_tile_types_34
    has_melds = len(hand.melds) > 0
    return Shanten.calculate_shanten(
        tiles_34,
        use_chiitoitsu=not has_melds,
        use_kokushi=not has_melds,
    )


def is_tenpai(hand: Hand) -> bool:
    """Check if hand is in tenpai (shanten == 0)."""
    return shanten_number(hand) <= 0


def waiting_tiles(hand: Hand) -> list[int]:
    """Return list of tile types (0-33) that would complete the hand.
    
    For each of the 34 tile types, temporarily add it and check if
    the hand becomes complete (shanten == -1).
    """
    if shanten_number(hand) != 0:
        return []

    tiles_34 = hand.closed_tile_types_34
    has_melds = len(hand.melds) > 0
    waits = []

    for tt in range(NUM_TILE_TYPES):
        # Check there are tiles available (max 4 per type, minus those in hand/melds)
        total_in_hand = hand.all_tile_types_34[tt]
        if total_in_hand >= 4:
            continue
        # Temporarily add this tile
        tiles_34[tt] += 1
        s = Shanten.calculate_shanten(
            tiles_34,
            use_chiitoitsu=not has_melds,
            use_kokushi=not has_melds,
        )
        tiles_34[tt] -= 1
        if s == -1:
            waits.append(tt)

    return waits


def is_furiten(hand: Hand, waits: list[int] | None = None) -> bool:
    """Check if player is in furiten (振聴).
    
    A player is furiten if any of their waiting tiles appears in their discards.
    """
    if waits is None:
        waits = waiting_tiles(hand)
    if not waits:
        return False
    discard_types = {tile_type(t) for t in hand.all_discards}
    return bool(discard_types & set(waits))


def count_available_tiles(hand: Hand, waits: list[int], all_visible: list[int]) -> dict[int, int]:
    """Count how many of each waiting tile are still potentially available.
    
    all_visible: all tile IDs that are visible (own hand, all discards, all melds).
    Returns {tile_type: remaining_count}.
    """
    visible_counts = to_34_array(all_visible)
    return {tt: 4 - visible_counts[tt] for tt in waits if visible_counts[tt] < 4}
