"""
Scoring system wrapping the `mahjong` library's HandCalculator.
Computes yaku, han, fu, and point values.

mahjong v2.0.0 API notes:
- HandCalculator.estimate_hand_value is a static method
- HandConfig: no is_dealer param; dealer is auto-detected via player_wind=EAST
- Wind constants: EAST=27, SOUTH=28, WEST=29, NORTH=30 (same as tile type indices)
- cost is a ScoresResult TypedDict with keys: main, additional, main_bonus,
  additional_bonus, kyoutaku_bonus, total, yaku_level
"""

from __future__ import annotations
from mahjong.hand_calculating.hand import HandCalculator
from mahjong.hand_calculating.hand_config import HandConfig, OptionalRules
from mahjong.meld import Meld as MahjongMeld
from game.tiles import tile_type
from game.hand import Hand
from game.melds import Meld, MeldType


MAJSOUL_RULES = {
    "has_open_tanyao": True,
    "has_aka_dora": True,
    "has_double_yakuman": True,
    "kiriage": False,
    "renhou_as_yakuman": False,
}


def _convert_melds(melds: list[Meld]) -> list[MahjongMeld]:
    """Convert our Meld objects to mahjong library Meld format."""
    result = []
    for m in melds:
        tiles_136 = sorted(m.tiles)
        if m.meld_type == MeldType.CHI:
            result.append(MahjongMeld(meld_type=MahjongMeld.CHI, tiles=tiles_136, opened=True))
        elif m.meld_type == MeldType.PON:
            result.append(MahjongMeld(meld_type=MahjongMeld.PON, tiles=tiles_136, opened=True))
        elif m.meld_type in (MeldType.MINKAN, MeldType.KAKAN):
            result.append(MahjongMeld(meld_type=MahjongMeld.KAN, tiles=tiles_136, opened=True))
        elif m.meld_type == MeldType.ANKAN:
            result.append(MahjongMeld(meld_type=MahjongMeld.KAN, tiles=tiles_136, opened=False))
    return result


class ScoreResult:
    def __init__(self, han: int, fu: int, cost_main: int, cost_additional: int,
                 yaku: list[str], yaku_level: str, total: int,
                 uradora_indicators: list[int] | None = None):
        self.han = han
        self.fu = fu
        self.cost_main = cost_main
        self.cost_additional = cost_additional
        self.yaku = yaku
        self.yaku_level = yaku_level
        self.total = total
        self.uradora_indicators = uradora_indicators or []

    def to_dict(self) -> dict:
        return {
            "han": self.han,
            "fu": self.fu,
            "yaku": self.yaku,
            "yaku_level": self.yaku_level,
            "cost_main": self.cost_main,
            "cost_additional": self.cost_additional,
            "total": self.total,
            "uradora_indicators": self.uradora_indicators,
        }


def calculate_score(
    hand: Hand,
    win_tile: int | None,
    is_tsumo: bool,
    is_dealer: bool,
    round_wind_tt: int,       # tile type of round wind (27=east, etc.)
    player_wind_tt: int,      # tile type of player's seat wind
    dora_indicators: list[int],  # dora indicator tile IDs (136-format)
    is_rinshan: bool = False,
    is_chankan: bool = False,
    is_haitei: bool = False,
    is_houtei: bool = False,
    is_tenhou: bool = False,
    is_chiihou: bool = False,
    is_riichi: bool = False,
    is_daburu_riichi: bool = False,
    is_ippatsu: bool = False,
    is_nagashi_mangan: bool = False,
    is_renhou: bool = False,
    ura_dora_indicators: list[int] | None = None,
) -> ScoreResult | None:
    """Calculate the score for a winning hand.
    
    Returns ScoreResult or None if the hand is not a valid winning hand.
    """
    # Build 136-format tile array: closed hand + all meld tiles + win_tile (if not already present, e.g. ron)
    if is_nagashi_mangan:
        tiles_136 = []
        melds = None
    else:
        tiles_136 = list(hand.closed) + [t for m in hand.melds for t in m.tiles]
        if win_tile is not None and win_tile not in tiles_136:
            tiles_136.append(win_tile)
        tiles_136.sort()
        melds = _convert_melds(hand.melds)

    config = HandConfig(
        is_tsumo=is_tsumo,
        is_riichi=is_riichi,
        is_daburu_riichi=is_daburu_riichi,
        is_ippatsu=is_ippatsu,
        is_rinshan=is_rinshan,
        is_chankan=is_chankan,
        is_haitei=is_haitei,
        is_houtei=is_houtei,
        is_nagashi_mangan=is_nagashi_mangan,
        is_tenhou=is_tenhou,
        is_renhou=is_renhou,
        is_chiihou=is_chiihou,
        player_wind=player_wind_tt,
        round_wind=round_wind_tt,
        options=OptionalRules(
            has_open_tanyao=MAJSOUL_RULES["has_open_tanyao"],
            has_aka_dora=MAJSOUL_RULES["has_aka_dora"],
            has_double_yakuman=MAJSOUL_RULES["has_double_yakuman"],
            kiriage=MAJSOUL_RULES["kiriage"],
            renhou_as_yakuman=MAJSOUL_RULES["renhou_as_yakuman"],
        ),
    )

    try:
        result = HandCalculator.estimate_hand_value(
            tiles=tiles_136,
            win_tile=win_tile,
            melds=melds if melds else None,
            dora_indicators=dora_indicators if dora_indicators else None,
            ura_dora_indicators=ura_dora_indicators if ura_dora_indicators else None,
            config=config,
        )
    except Exception:
        return None

    if result.error:
        return None

    cost = result.cost
    yaku_list = [str(y) for y in result.yaku]
    return ScoreResult(
        han=result.han,
        fu=result.fu,
        cost_main=cost["main"],
        cost_additional=cost["additional"],
        yaku=yaku_list,
        yaku_level=cost.get("yaku_level", ""),
        total=cost["total"],
        uradora_indicators=ura_dora_indicators,
    )


def points_transfer_2p(
    score: ScoreResult,
    is_tsumo: bool,
    is_dealer_win: bool,
) -> int:
    """Calculate total points transferred from loser in 2-player game.
    
    In 2-player: the single opponent pays everything.
    
    Ron: opponent pays cost_main directly.
    Tsumo:
      - Dealer tsumo: In 4p, 3 non-dealers each pay cost_additional.
        In 2p, opponent pays cost_additional * 2 (common 2p rule).
      - Non-dealer tsumo: In 4p, dealer pays cost_main, 2 non-dealers pay cost_additional.
        In 2p, opponent (dealer) pays cost_main + cost_additional.
    """
    if not is_tsumo:
        return score.cost_main

    if is_dealer_win:
        # Dealer tsumo: opponent pays double the per-player amount
        return score.cost_additional * 2
    else:
        # Non-dealer tsumo: opponent is dealer, pays dealer share + 1 non-dealer share
        return score.cost_main + score.cost_additional
