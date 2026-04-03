"""
Game engine: the state machine driving a full 2-player mahjong match.

States
------
WAITING        – waiting for both players to join
ROUND_START    – set up a new round (shuffle, deal)
PHASE1_DRAW    – active player draws a tile
PHASE1_ACTION  – active player decides: discard / tsumo / ankan / kakan / declare tenpai
PHASE1_RESPONSE– opponent responds to a discard: chi / pon / kan / ron / pass
PHASE2_GUESS   – opponent guesses 2 tiles
PHASE2_DRAW    – tenpai declarer draws up to 5 tiles one-by-one
PHASE2_ACTION  – tenpai declarer chooses discard / ankan / kakan after a Phase 2 draw
ROUND_END      – settle points, check game-over condition
GAME_OVER      – final results
"""

from __future__ import annotations
import asyncio
import time
from enum import Enum
from dataclasses import dataclass, field
from game.tiles import tile_type, tile_name, tile_type_name, NUM_TILE_TYPES, number_of, is_honor
from game.wall import Wall
from game.hand import Hand
from game.melds import Meld, MeldType
from game.tenpai import (
    shanten_number,
    is_tenpai,
    waiting_tiles,
    is_furiten,
)
from game.scoring import calculate_score, points_transfer_2p, ScoreResult
from config import STARTING_POINTS


class Phase(str, Enum):
    WAITING = "waiting"
    ROUND_START = "round_start"
    PHASE1_DRAW = "phase1_draw"
    PHASE1_ACTION = "phase1_action"
    PHASE1_RESPONSE = "phase1_response"
    PHASE2_GUESS = "phase2_guess"
    PHASE2_DRAW = "phase2_draw"
    PHASE2_ACTION = "phase2_action"
    ROUND_END = "round_end"
    GAME_OVER = "game_over"


@dataclass
class PlayerState:
    user_id: int
    username: str
    seat: int  # 0 or 1
    points: int = STARTING_POINTS
    hand: Hand = field(default_factory=Hand)
    is_dealer: bool = False
    declared_tenpai: bool = False
    declared_riichi: bool = False
    declared_daburu_riichi: bool = False
    tenpai_waits: list[int] = field(default_factory=list)  # tile types
    is_furiten: bool = False


@dataclass
class RoundResult:
    result_type: str  # "tsumo", "ron", "draw", "phase2_guess_hit"
    winner: int | None = None  # seat index
    loser: int | None = None
    score: ScoreResult | None = None
    points_delta: dict[int, int] = field(default_factory=dict)  # seat -> delta
    details: dict = field(default_factory=dict)


class GameEngine:
    """Core state machine for a 2-player mahjong game."""

    def __init__(self, timer_minutes: int = 30):
        self.players: list[PlayerState | None] = [None, None]
        self.phase: Phase = Phase.WAITING
        self.wall: Wall = Wall()

        # Round tracking
        self.round_number: int = 0
        self.dealer_seat: int = 0  # seat 0 or 1
        self.round_wind_tt: int = 27  # 東 for now (no wind rotation needed)
        self.honba_count: int = 0
        self.riichi_sticks: int = 0
        self.current_turn: int = 0  # seat of current active player
        self.first_draw_done: bool = False  # for tenhou/chiihou detection
        self._round_has_interruption: bool = False
        self._called_discards_by_seat: dict[int, set[int]] = {0: set(), 1: set()}
        self._pending_damaten: set[int] = set()
        self._ippatsu_pending: set[int] = set()

        # Phase 2 state
        self.tenpai_declarer: int | None = None
        self.phase2_draw_count: int = 0
        self.phase2_guessed_types_by_seat: dict[int, set[int]] = {0: set(), 1: set()}
        self._phase2_draw_lock = asyncio.Lock()
        self._is_rinshan_draw: bool = False

        # Chankan recovery state
        self._pending_kakan: tuple | None = None  # (seat, tile_id, target_meld)
        self._total_kan_count: int = 0  # total kans declared (for 4-kan abort)

        # Temporary furiten tracking
        self._temp_furiten: set[int] = set()  # seats with temporary furiten

        # Pending response state
        self.last_discard: int | None = None
        self.last_discard_seat: int | None = None
        self.available_calls: dict = {}  # populated when waiting for response

        # Timer
        self.timer_minutes: int = timer_minutes
        self.game_start_time: float | None = None
        self.is_last_round: bool = False

        # Results
        self.round_result: RoundResult | None = None
        self.game_over: bool = False

        # Ready tracking for next round
        self._ready: set[int] = set()  # seats that confirmed ready

        # Callback for sending messages (set by room/ws_handler)
        self._notify: callable = None

    def set_notify(self, callback):
        """Set the async callback for sending messages: callback(event_type, data, target_seat=None)"""
        self._notify = callback

    def _serialize_result_hand(self, hand: Hand) -> dict:
        """Serialize a full hand for end-of-round reveal."""
        return {
            "closed": list(hand.closed),
            "melds": [m.to_dict() for m in hand.melds],
        }

    async def notify(self, event_type: str, data: dict, target_seat: int | None = None):
        if self._notify:
            await self._notify(event_type, data, target_seat)

    def _safe_is_tenpai(self, hand: Hand) -> bool:
        try:
            return is_tenpai(hand)
        except ValueError:
            return False

    def _safe_waiting_tiles(self, hand: Hand) -> list[int]:
        try:
            return waiting_tiles(hand)
        except ValueError:
            return []

    def _tenpai_preserving_discards(self, hand: Hand, forbid_furiten: bool = False) -> list[int]:
        valid_discards: list[int] = []
        original_tiles = list(hand.closed)
        for tile_id in original_tiles:
            hand.closed.remove(tile_id)
            hand.discards.append(tile_id)
            try:
                if shanten_number(hand) == 0:
                    waits = self._safe_waiting_tiles(hand)
                    if not forbid_furiten or not waits or not is_furiten(hand, waits):
                        valid_discards.append(tile_id)
            except ValueError:
                pass
            hand.discards.pop()
            hand.closed.append(tile_id)
            hand.closed.sort(key=tile_type)
        return valid_discards

    def _tenpai_declaration_discards(self, hand: Hand) -> list[int]:
        return self._tenpai_preserving_discards(hand, forbid_furiten=True)

    def _clone_hand(self, hand: Hand) -> Hand:
        clone = Hand()
        clone.closed = list(hand.closed)
        clone.melds = [Meld(meld.meld_type, list(meld.tiles), meld.called_tile) for meld in hand.melds]
        clone.discards = list(hand.discards)
        clone.hidden_discards = list(hand.hidden_discards)
        clone.draw_tile = hand.draw_tile
        return clone

    def _locked_tenpai_signature(self, hand: Hand) -> tuple[int, ...] | None:
        try:
            if shanten_number(hand) != 0:
                return None
            return tuple(sorted(self._safe_waiting_tiles(hand)))
        except ValueError:
            return None

    def _locked_tenpai_ankan_options(self, player: PlayerState) -> list[list[int]]:
        locked_waits = tuple(sorted(player.tenpai_waits))
        valid_groups: list[list[int]] = []
        for group in player.hand.can_ankan():
            simulated_hand = self._clone_hand(player.hand)
            simulated_hand.do_ankan(list(group))
            if self._locked_tenpai_signature(simulated_hand) == locked_waits:
                valid_groups.append(group)
        return valid_groups

    def _locked_tenpai_kakan_options(self, player: PlayerState) -> list[tuple[Meld, int]]:
        locked_waits = tuple(sorted(player.tenpai_waits))
        valid_groups: list[tuple[Meld, int]] = []
        for meld, extra_tile in player.hand.can_kakan():
            simulated_hand = self._clone_hand(player.hand)
            simulated_meld = next(
                clone_meld
                for clone_meld in simulated_hand.melds
                if clone_meld.meld_type == MeldType.PON and tile_type(clone_meld.tiles[0]) == tile_type(meld.tiles[0])
            )
            simulated_hand.do_kakan(simulated_meld, extra_tile)
            if self._locked_tenpai_signature(simulated_hand) == locked_waits:
                valid_groups.append((meld, extra_tile))
        return valid_groups

    def _can_declare_tenpai(self, player: PlayerState) -> bool:
        return (
            self.tenpai_declarer is None
            and not player.declared_tenpai
            and shanten_number(player.hand) == 0
            and bool(self._tenpai_declaration_discards(player.hand))
        )

    def _can_declare_riichi(self, player: PlayerState) -> bool:
        return (
            self._can_declare_tenpai(player)
            and not player.hand.is_open
            and player.points >= 1000
        )

    def _phase1_ankan_options(self, player: PlayerState) -> list[list[int]]:
        if player.declared_riichi:
            return self._locked_tenpai_ankan_options(player)
        if player.declared_tenpai:
            return []
        return player.hand.can_ankan()

    def _phase1_kakan_options(self, player: PlayerState) -> list[tuple[Meld, int]]:
        if player.declared_tenpai:
            return []
        return player.hand.can_kakan()

    def _response_target_seat(self) -> int | None:
        if self.last_discard_seat is None:
            return None
        return self.opponent_seat(self.last_discard_seat)

    def _response_action_allowed(self, seat: int, action_key: str) -> bool:
        return (
            self.phase == Phase.PHASE1_RESPONSE
            and seat == self._response_target_seat()
            and action_key in self.available_calls
        )

    def _clear_ippatsu(self, seat: int | None = None):
        if seat is None:
            self._ippatsu_pending.clear()
            return
        self._ippatsu_pending.discard(seat)

    def _is_terminal_or_honor(self, tile_id: int) -> bool:
        tt = tile_type(tile_id)
        return is_honor(tt) or number_of(tt) in (1, 9)

    def _mark_discard_called(self, seat: int | None, tile_id: int | None):
        if seat is None or tile_id is None:
            return
        self._called_discards_by_seat.setdefault(seat, set()).add(tile_id)

    def _is_daburu_riichi_available(self, player: PlayerState) -> bool:
        return not self._round_has_interruption and len(player.hand.discards) == 0

    def _nagashi_mangan_qualifiers(self) -> list[int]:
        qualifiers: list[int] = []
        for player in self.players:
            if player is None or not player.hand.discards:
                continue
            if self._called_discards_by_seat.get(player.seat):
                continue
            if all(self._is_terminal_or_honor(tile_id) for tile_id in player.hand.discards):
                qualifiers.append(player.seat)
        return qualifiers

    def _phase2_guess_blocked_types(self, seat: int) -> set[int]:
        guessed = set(self.phase2_guessed_types_by_seat.get(seat, set()))
        if self.tenpai_declarer is None:
            return guessed
        declarer = self.players[self.tenpai_declarer]
        discarded = {tile_type(tile_id) for tile_id in declarer.hand.discards}
        return guessed | discarded

    def _phase2_guess_selectable_types(self, seat: int) -> list[int]:
        blocked = self._phase2_guess_blocked_types(seat)
        return [tt for tt in range(NUM_TILE_TYPES) if tt not in blocked]

    def _phase2_guess_request_payload(self, seat: int, retry: bool = False, invalid: bool = False) -> dict:
        selectable_types = self._phase2_guess_selectable_types(seat)
        required_count = min(2, len(selectable_types))

        if required_count == 0:
            message = '5次摸牌结束，已无可选牌，可跳过本轮猜牌。' if retry else '已经没有可选牌，可跳过本轮猜牌。'
        elif required_count == 1:
            if invalid:
                message = '只有1张牌可选，请选择这1张未被系统禁用的牌。'
            else:
                message = '5次摸牌结束，只剩1张牌可选，请按能选多少选多少。' if retry else '只剩1张牌可选，请按能选多少选多少。'
        else:
            if invalid:
                message = '已有无效选择，请重新选择2张未猜过且未被系统禁用的牌。'
            else:
                message = '5次摸牌结束，未和牌。请再次选择2张牌进行猜测。' if retry else '请选择2张牌进行猜测'

        return {
            'message': message,
            'already_guessed': sorted(self.phase2_guessed_types_by_seat.get(seat, set())),
            'required_count': required_count,
            'selectable_count': len(selectable_types),
            'can_skip': required_count == 0,
        }

    # ------------------------------------------------------------------
    # Player management
    # ------------------------------------------------------------------

    def add_player(self, user_id: int, username: str) -> int | None:
        """Add a player, return seat index or None if full."""
        for i in range(2):
            if self.players[i] is not None and self.players[i].user_id == user_id:
                return i  # already joined
        for i in range(2):
            if self.players[i] is None:
                self.players[i] = PlayerState(user_id=user_id, username=username, seat=i)
                return i
        return None

    def get_player_by_user(self, user_id: int) -> PlayerState | None:
        for p in self.players:
            if p and p.user_id == user_id:
                return p
        return None

    def opponent_seat(self, seat: int) -> int:
        return 1 - seat

    def both_joined(self) -> bool:
        return self.players[0] is not None and self.players[1] is not None

    # ------------------------------------------------------------------
    # Game flow
    # ------------------------------------------------------------------

    async def start_game(self):
        """Called when both players are ready."""
        self.game_start_time = time.time()
        self.round_number = 0
        self.dealer_seat = 0
        self.players[0].is_dealer = True
        self.players[1].is_dealer = False
        await self.start_round()

    async def start_round(self):
        """Set up and deal a new round."""
        self.phase = Phase.ROUND_START
        self.round_number += 1
        self.first_draw_done = False
        self.tenpai_declarer = None
        self.phase2_draw_count = 0
        self.phase2_guessed_types_by_seat = {0: set(), 1: set()}
        self.last_discard = None
        self.last_discard_seat = None
        self.available_calls = {}
        self.round_result = None
        self._pending_kakan = None
        self._pending_damaten.clear()
        self._ippatsu_pending.clear()
        self._round_has_interruption = False
        self._called_discards_by_seat = {0: set(), 1: set()}
        self._temp_furiten.clear()
        self._is_rinshan_draw = False
        self._total_kan_count = 0

        # Update dealer flags
        for p in self.players:
            p.is_dealer = (p.seat == self.dealer_seat)
            p.hand = Hand()
            p.declared_tenpai = False
            p.declared_riichi = False
            p.declared_daburu_riichi = False
            p.tenpai_waits = []
            p.is_furiten = False

        # Shuffle and deal
        self.wall.setup()
        dealer = self.players[self.dealer_seat]
        non_dealer = self.players[self.opponent_seat(self.dealer_seat)]
        dealer.hand.init_deal(self.wall.deal(13))
        non_dealer.hand.init_deal(self.wall.deal(13))

        # Dealer goes first
        self.current_turn = self.dealer_seat

        # Check timer
        if self.game_start_time:
            elapsed = time.time() - self.game_start_time
            if elapsed >= self.timer_minutes * 60:
                self.is_last_round = True

        await self.notify("round_start", self._round_start_data())

        # Send each player their dealt hand
        for p in self.players:
            await self.notify("deal", {
                "hand": p.hand.to_dict(hide_tiles=False),
                "opponent_closed_count": 13,
            }, target_seat=p.seat)

        await self._do_draw()

    async def _do_draw(self):
        """Active player draws a tile."""
        self.phase = Phase.PHASE1_DRAW
        player = self.players[self.current_turn]
        tile = self.wall.draw()

        if tile is None:
            # Wall exhausted -> draw (流局)
            await self._end_round_draw()
            return

        player.hand.add_draw(tile)

        # Clear temporary furiten on draw
        self._temp_furiten.discard(self.current_turn)
        self._is_rinshan_draw = False

        # Check for tsumo (agari) — furiten only blocks ron, NOT tsumo
        can_tsumo = shanten_number(player.hand) == -1

        # Riichi after declaration only keeps ankans that preserve the locked waits.
        ankans = self._phase1_ankan_options(player)

        # Kakan is blocked after any tenpai declaration.
        kakans = self._phase1_kakan_options(player)

        # Check if can declare tenpai (Phase 2 not yet active, hand close to tenpai)
        can_declare_tenpai = self._can_declare_tenpai(player)
        can_declare_riichi = self._can_declare_riichi(player)

        # Is this haitei (last drawable tile)?
        is_haitei = self.wall.remaining == 0

        self.phase = Phase.PHASE1_ACTION

        # Calculate waiting tiles for tenpai display
        my_waits = []
        if self._safe_is_tenpai(player.hand):
            my_waits = self._safe_waiting_tiles(player.hand)

        actions = {
            "must_discard": True,
            "can_tsumo": can_tsumo,
            "can_ankan": [[t for t in group] for group in ankans],
            "can_kakan": [(m.to_dict(), extra) for m, extra in kakans],
            "can_declare_tenpai": can_declare_tenpai,
            "can_declare_riichi": can_declare_riichi,
            "can_declare_damaten": can_declare_riichi,
            "is_haitei": is_haitei,
        }

        await self.notify("draw_tile", {
            "seat": self.current_turn,
            "tile": tile,
            "wall_remaining": self.wall.remaining,
            "actions": actions,
            "waiting_tiles": [tile_type_name(tt) for tt in my_waits],
        }, target_seat=self.current_turn)

        # Notify opponent that a draw happened (no tile info)
        await self.notify("opponent_draw", {
            "seat": self.current_turn,
            "wall_remaining": self.wall.remaining,
        }, target_seat=self.opponent_seat(self.current_turn))

    # ------------------------------------------------------------------
    # Phase 1 actions (from active player after drawing)
    # ------------------------------------------------------------------

    async def action_discard(self, seat: int, tile_id: int):
        """Player discards a tile."""
        if self.phase != Phase.PHASE1_ACTION or self.current_turn != seat:
            return
        player = self.players[seat]
        if tile_id not in player.hand.closed:
            return

        player.hand.discard(tile_id)
        self.last_discard = tile_id
        self.last_discard_seat = seat
        self.first_draw_done = True

        # Update furiten for this player
        waits = self._safe_waiting_tiles(player.hand) if self._safe_is_tenpai(player.hand) else []
        if waits:
            player.is_furiten = is_furiten(player.hand, waits)

        # Check what opponent can do
        opp_seat = self.opponent_seat(seat)
        opponent = self.players[opp_seat]

        calls = {}
        # Ron? (check permanent furiten AND temporary furiten)
        opp_waits = self._safe_waiting_tiles(opponent.hand) if self._safe_is_tenpai(opponent.hand) else []
        if opp_waits and tile_type(tile_id) in opp_waits and not opponent.is_furiten and opp_seat not in self._temp_furiten:
            calls["can_ron"] = True

        # Chi?
        chi_options = opponent.hand.can_chi(tile_id)
        if chi_options:
            calls["can_chi"] = chi_options

        # Pon?
        pon_tiles = opponent.hand.can_pon(tile_id)
        if pon_tiles:
            calls["can_pon"] = pon_tiles

        # Minkan?
        kan_tiles = opponent.hand.can_minkan(tile_id)
        if kan_tiles:
            calls["can_minkan"] = kan_tiles

        is_houtei = self.wall.remaining == 0

        self.available_calls = calls

        await self.notify("discard", {
            "seat": seat,
            "tile": tile_id,
            "wall_remaining": self.wall.remaining,
        })

        if calls:
            self.phase = Phase.PHASE1_RESPONSE
            await self.notify("call_available", {
                "calls": calls,
                "discard_tile": tile_id,
                "discard_seat": seat,
                "is_houtei": is_houtei,
            }, target_seat=opp_seat)
        else:
            # No calls available, next turn
            if self.wall.remaining == 0:
                await self._end_round_draw()
            else:
                self.current_turn = opp_seat
                await self._do_draw()

    async def action_tsumo(self, seat: int):
        """Player declares tsumo (self-draw win)."""
        is_phase1 = self.phase == Phase.PHASE1_ACTION
        is_phase2 = self.phase == Phase.PHASE2_ACTION and seat == self.tenpai_declarer
        if self.current_turn != seat or (not is_phase1 and not is_phase2):
            return
        player = self.players[seat]
        if shanten_number(player.hand) != -1:
            return
        # Note: furiten does NOT block tsumo, only ron

        win_tile = player.hand.draw_tile
        if win_tile is None:
            return

        is_haitei = self.wall.remaining == 0

        score = calculate_score(
            hand=player.hand,
            win_tile=win_tile,
            is_tsumo=True,
            is_dealer=player.is_dealer,
            round_wind_tt=self.round_wind_tt,
            player_wind_tt=27 if player.is_dealer else 28,
            dora_indicators=self.wall.dora_indicators,
            is_rinshan=self._is_rinshan_draw,
            is_haitei=is_haitei,
            is_tenhou=player.is_dealer and not self.first_draw_done,
            is_chiihou=not player.is_dealer and not self.first_draw_done,
            is_riichi=player.declared_riichi,
            is_daburu_riichi=player.declared_daburu_riichi,
            is_ippatsu=seat in self._ippatsu_pending,
            ura_dora_indicators=self.wall.get_uradora_indicators() if player.declared_riichi else None,
        )

        if score is None:
            return

        await self._end_round_win(seat, score, is_tsumo=True, win_tile=win_tile)

    async def action_ankan(self, seat: int, tiles: list[int]):
        """Player declares closed kan."""
        in_phase2 = self.phase == Phase.PHASE2_ACTION and self.current_turn == seat and self.tenpai_declarer == seat
        if self.current_turn != seat or (self.phase != Phase.PHASE1_ACTION and not in_phase2):
            return
        player = self.players[seat]
        # Outside Phase2, only riichi can keep a locked-shape ankan; other tenpai declarations stay blocked.
        if player.declared_tenpai and not in_phase2 and not player.declared_riichi:
            return
        if len(tiles) != 4 or len(set(tiles)) != 4:
            return
        if not all(t in player.hand.closed for t in tiles):
            return
        if in_phase2 or player.declared_riichi:
            valid_ankans = {tuple(sorted(group)) for group in self._locked_tenpai_ankan_options(player)}
            if tuple(sorted(tiles)) not in valid_ankans:
                return
        # Validate all tiles are the same type
        if len(set(tile_type(t) for t in tiles)) != 1:
            return

        self._clear_ippatsu()
        self._round_has_interruption = True

        player.hand.do_ankan(tiles)
        self.first_draw_done = True
        self._total_kan_count += 1

        # 4-kan abort: if total kans by different players >= 4 and both have kans
        if self._total_kan_count >= 4:
            p0_kans = sum(1 for m in self.players[0].hand.melds if m.meld_type.value in ('ankan', 'minkan', 'kakan'))
            p1_kans = sum(1 for m in self.players[1].hand.melds if m.meld_type.value in ('ankan', 'minkan', 'kakan'))
            if p0_kans > 0 and p1_kans > 0:
                # Notify frontend of the kan before ending round (M4 fix)
                await self.notify("kan_declared", {
                    "seat": seat,
                    "type": "ankan",
                    "tiles": tiles,
                    "dora_indicators": self.wall.dora_indicators,
                })
                await self._end_round_draw(reason="four_kan_abort")
                return

        rinshan = self.wall.draw_rinshan()
        if rinshan is None:
            await self._end_round_draw()
            return

        player.hand.add_draw(rinshan)
        self._is_rinshan_draw = True

        if in_phase2:
            await self.notify("kan_declared", {
                "seat": seat,
                "type": "ankan",
                "tiles": tiles,
                "dora_indicators": self.wall.dora_indicators,
            })

            is_complete = shanten_number(player.hand) == -1
            score = None
            if is_complete:
                score = calculate_score(
                    hand=player.hand,
                    win_tile=rinshan,
                    is_tsumo=True,
                    is_dealer=player.is_dealer,
                    round_wind_tt=self.round_wind_tt,
                    player_wind_tt=27 if player.is_dealer else 28,
                    dora_indicators=self.wall.dora_indicators,
                    is_rinshan=True,
                    is_haitei=self.wall.remaining == 0,
                    is_riichi=player.declared_riichi,
                    is_daburu_riichi=player.declared_daburu_riichi,
                    is_ippatsu=seat in self._ippatsu_pending,
                    ura_dora_indicators=self.wall.get_uradora_indicators() if player.declared_riichi else None,
                )
            if score is not None:
                await self._end_round_win(seat, score, is_tsumo=True, win_tile=rinshan)
                return

            self.phase = Phase.PHASE2_ACTION
            self.current_turn = seat
            await self.notify("draw_tile", {
                "seat": seat,
                "tile": rinshan,
                "wall_remaining": self.wall.remaining,
                "phase": Phase.PHASE2_ACTION.value,
                "actions": self._phase2_actions_payload(player),
                "waiting_tiles": [tile_type_name(tt) for tt in player.tenpai_waits],
            }, target_seat=seat)
            return

        # Check for tsumo on rinshan — furiten does NOT block tsumo
        can_tsumo = shanten_number(player.hand) == -1
        ankans = self._phase1_ankan_options(player)
        kakans = self._phase1_kakan_options(player)
        can_declare_tenpai = self._can_declare_tenpai(player)
        can_declare_riichi = self._can_declare_riichi(player)

        self.phase = Phase.PHASE1_ACTION

        await self.notify("kan_declared", {
            "seat": seat,
            "type": "ankan",
            "tiles": tiles,
            "dora_indicators": self.wall.dora_indicators,
        })

        # Notify opponent about the rinshan draw
        await self.notify("opponent_draw", {
            "seat": seat,
            "wall_remaining": self.wall.remaining,
        }, target_seat=self.opponent_seat(seat))

        await self.notify("draw_tile", {
            "seat": seat,
            "tile": rinshan,
            "wall_remaining": self.wall.remaining,
            "actions": {
                "must_discard": True,
                "can_tsumo": can_tsumo,
                "can_ankan": [[t for t in group] for group in ankans],
                "can_kakan": [(m.to_dict(), extra) for m, extra in kakans],
                "can_declare_tenpai": can_declare_tenpai,
                "can_declare_riichi": can_declare_riichi,
                "is_rinshan": True,
            },
        }, target_seat=seat)

    async def action_kakan(self, seat: int, tile_id: int):
        """Player upgrades a pon to kan (加杠)."""
        in_phase2 = self.phase == Phase.PHASE2_ACTION and self.current_turn == seat and self.tenpai_declarer == seat
        if self.current_turn != seat or (self.phase != Phase.PHASE1_ACTION and not in_phase2):
            return
        player = self.players[seat]
        # Outside Phase2, locked tenpai cannot change shape through kakan.
        if player.declared_tenpai and not in_phase2:
            return
        if in_phase2:
            valid_kakan_tiles = {extra for _meld, extra in self._locked_tenpai_kakan_options(player)}
            if tile_id not in valid_kakan_tiles:
                return

        # Find the matching pon meld
        target_meld = None
        for meld in player.hand.melds:
            if meld.meld_type == MeldType.PON and tile_type(meld.tiles[0]) == tile_type(tile_id):
                target_meld = meld
                break
        if target_meld is None or tile_id not in player.hand.closed:
            return

        self._clear_ippatsu()
        self._round_has_interruption = True
        self.first_draw_done = True

        # Check chankan (opponent can ron on the added tile)
        opp_seat = self.opponent_seat(seat)
        opp = self.players[opp_seat]
        opp_waits = self._safe_waiting_tiles(opp.hand) if self._safe_is_tenpai(opp.hand) else []
        if (not in_phase2 and opp_waits and tile_type(tile_id) in opp_waits
            and not opp.is_furiten and opp_seat not in self._temp_furiten):
            # Chankan possible - ask opponent; save state for recovery if opponent passes
            self._pending_kakan = (seat, tile_id, target_meld)
            self.available_calls = {"can_ron": True, "is_chankan": True}
            self.last_discard = tile_id
            self.last_discard_seat = seat
            self.phase = Phase.PHASE1_RESPONSE

            await self.notify("chankan_available", {
                "seat": seat,
                "tile": tile_id,
            }, target_seat=opp_seat)
            return

        player.hand.do_kakan(target_meld, tile_id)
        self._total_kan_count += 1
        # 4-kan abort check (before drawing rinshan — M1 fix)
        if self._total_kan_count >= 4:
            p0_kans = sum(1 for m in self.players[0].hand.melds if m.meld_type.value in ('ankan', 'minkan', 'kakan'))
            p1_kans = sum(1 for m in self.players[1].hand.melds if m.meld_type.value in ('ankan', 'minkan', 'kakan'))
            if p0_kans > 0 and p1_kans > 0:
                await self._end_round_draw(reason="four_kan_abort")
                return

        rinshan = self.wall.draw_rinshan()
        if rinshan is None:
            await self._end_round_draw()
            return

        player.hand.add_draw(rinshan)
        self._is_rinshan_draw = True

        if in_phase2:
            await self.notify("kan_declared", {
                "seat": seat,
                "type": "kakan",
                "tiles": target_meld.tiles,
                "dora_indicators": self.wall.dora_indicators,
            })

            is_complete = shanten_number(player.hand) == -1
            score = None
            if is_complete:
                score = calculate_score(
                    hand=player.hand,
                    win_tile=rinshan,
                    is_tsumo=True,
                    is_dealer=player.is_dealer,
                    round_wind_tt=self.round_wind_tt,
                    player_wind_tt=27 if player.is_dealer else 28,
                    dora_indicators=self.wall.dora_indicators,
                    is_rinshan=True,
                    is_haitei=self.wall.remaining == 0,
                    is_riichi=player.declared_riichi,
                    is_daburu_riichi=player.declared_daburu_riichi,
                    is_ippatsu=seat in self._ippatsu_pending,
                    ura_dora_indicators=self.wall.get_uradora_indicators() if player.declared_riichi else None,
                )
            if score is not None:
                await self._end_round_win(seat, score, is_tsumo=True, win_tile=rinshan)
                return

            self.phase = Phase.PHASE2_ACTION
            self.current_turn = seat
            await self.notify("draw_tile", {
                "seat": seat,
                "tile": rinshan,
                "wall_remaining": self.wall.remaining,
                "phase": Phase.PHASE2_ACTION.value,
                "actions": self._phase2_actions_payload(player),
                "waiting_tiles": [tile_type_name(tt) for tt in player.tenpai_waits],
            }, target_seat=seat)
            return

        can_tsumo = shanten_number(player.hand) == -1  # furiten does NOT block tsumo
        ankans = player.hand.can_ankan()
        kakans = player.hand.can_kakan()

        self.phase = Phase.PHASE1_ACTION

        await self.notify("kan_declared", {
            "seat": seat,
            "type": "kakan",
            "tiles": target_meld.tiles,
            "dora_indicators": self.wall.dora_indicators,
        })

        # Notify opponent about the rinshan draw
        await self.notify("opponent_draw", {
            "seat": seat,
            "wall_remaining": self.wall.remaining,
        }, target_seat=self.opponent_seat(seat))

        await self.notify("draw_tile", {
            "seat": seat,
            "tile": rinshan,
            "wall_remaining": self.wall.remaining,
            "actions": {
                "must_discard": True,
                "can_tsumo": can_tsumo,
                "can_ankan": [[t for t in group] for group in ankans],
                "can_kakan": [(m.to_dict(), extra) for m, extra in kakans],
                "can_declare_tenpai": False,
                "is_rinshan": True,
            },
        }, target_seat=seat)

    async def action_declare_tenpai(self, seat: int, riichi: bool = False):
        """Player declares tenpai, triggering Phase 2."""
        if self.phase != Phase.PHASE1_ACTION or self.current_turn != seat:
            return
        if self.tenpai_declarer is not None:
            return

        player = self.players[seat]

        # Player must be in tenpai form (shanten == 0 with 14 tiles)
        # and have at least one non-furiten declaration discard.
        if shanten_number(player.hand) != 0:
            return

        if riichi and not self._can_declare_riichi(player):
            return
        if not riichi and not self._can_declare_tenpai(player):
            return

        player.declared_tenpai = True
        player.declared_riichi = riichi
        player.declared_daburu_riichi = riichi and self._is_daburu_riichi_available(player)
        waits = self._safe_waiting_tiles(player.hand)
        player.tenpai_waits = waits  # may be empty for kara-ten (空听)
        self.tenpai_declarer = seat

        if riichi:
            player.points -= 1000
            self.riichi_sticks += 1

        await self.notify("tenpai_declared", {
            "seat": seat,
            "riichi": riichi,
            "daburu_riichi": player.declared_daburu_riichi,
            "points": {p.seat: p.points for p in self.players},
            "riichi_sticks": self.riichi_sticks,
            "honba_count": self.honba_count,
        })

        await self.notify("must_discard", {
            "seat": seat,
            "tenpai_discards": self._tenpai_declaration_discards(player.hand),
            "tenpai_mode": "riichi" if riichi else "public_tenpai",
        }, target_seat=seat)

        # Player still needs to discard before Phase 2 kicks in
        # But actually - the declare happens and then the player must still
        # discard a tile to proceed. After that discard, we enter Phase 2
        # instead of normal response.
        # For simplicity: after declaring tenpai, the player must discard.
        # The discard won't trigger normal chi/pon response; instead we go to Phase 2.

    async def action_declare_damaten(self, seat: int):
        """Player chooses hidden tenpai (damaten) and must discard a tenpai-preserving tile."""
        if self.phase != Phase.PHASE1_ACTION or self.current_turn != seat:
            return

        player = self.players[seat]
        if not self._can_declare_riichi(player):
            return

        self._pending_damaten.add(seat)
        player.tenpai_waits = self._safe_waiting_tiles(player.hand)

        await self.notify("must_discard", {
            "seat": seat,
            "tenpai_discards": self._tenpai_declaration_discards(player.hand),
            "tenpai_mode": "damaten",
        }, target_seat=seat)

    async def action_discard_after_tenpai(self, seat: int, tile_id: int):
        """After declaring tenpai, player discards and we move to Phase 2."""
        if self.phase != Phase.PHASE1_ACTION or self.current_turn != seat:
            return
        player = self.players[seat]
        if tile_id not in player.hand.closed:
            return
        if tile_id not in self._tenpai_declaration_discards(player.hand):
            return

        player.hand.discard(tile_id)
        self.last_discard = tile_id
        self.last_discard_seat = seat
        self.first_draw_done = True

        # Recalculate waits after discard
        waits = self._safe_waiting_tiles(player.hand)
        player.tenpai_waits = waits
        player.is_furiten = is_furiten(player.hand, waits) if waits else False

        await self.notify("discard", {
            "seat": seat,
            "tile": tile_id,
            "wall_remaining": self.wall.remaining,
        })

        # Check if opponent can ron this discard
        opp_seat = self.opponent_seat(seat)
        opp = self.players[opp_seat]
        opp_waits = self._safe_waiting_tiles(opp.hand) if self._safe_is_tenpai(opp.hand) else []
        if opp_waits and tile_type(tile_id) in opp_waits and not opp.is_furiten and opp_seat not in self._temp_furiten:
            self.available_calls = {"can_ron": True}
            self.phase = Phase.PHASE1_RESPONSE
            await self.notify("call_available", {
                "calls": {"can_ron": True},
                "discard_tile": tile_id,
                "discard_seat": seat,
            }, target_seat=opp_seat)
            return

        if player.declared_riichi:
            self._ippatsu_pending.add(seat)

        # Enter Phase 2
        await self._enter_phase2()

    async def action_discard_after_damaten(self, seat: int, tile_id: int):
        """After choosing damaten, discard while keeping tenpai and remain hidden."""
        if self.phase != Phase.PHASE1_ACTION or self.current_turn != seat or seat not in self._pending_damaten:
            return

        player = self.players[seat]
        if tile_id not in player.hand.closed:
            return
        if tile_id not in self._tenpai_declaration_discards(player.hand):
            return

        self._pending_damaten.discard(seat)
        player.hand.discard(tile_id)
        self.last_discard = tile_id
        self.last_discard_seat = seat
        self.first_draw_done = True

        waits = self._safe_waiting_tiles(player.hand)
        player.tenpai_waits = waits
        if waits:
            player.is_furiten = is_furiten(player.hand, waits)

        opp_seat = self.opponent_seat(seat)
        opponent = self.players[opp_seat]

        calls = {}
        opp_waits = self._safe_waiting_tiles(opponent.hand) if self._safe_is_tenpai(opponent.hand) else []
        if opp_waits and tile_type(tile_id) in opp_waits and not opponent.is_furiten and opp_seat not in self._temp_furiten:
            calls["can_ron"] = True

        chi_options = opponent.hand.can_chi(tile_id)
        if chi_options:
            calls["can_chi"] = chi_options

        pon_tiles = opponent.hand.can_pon(tile_id)
        if pon_tiles:
            calls["can_pon"] = pon_tiles

        kan_tiles = opponent.hand.can_minkan(tile_id)
        if kan_tiles:
            calls["can_minkan"] = kan_tiles

        self.available_calls = calls

        await self.notify("discard", {
            "seat": seat,
            "tile": tile_id,
            "wall_remaining": self.wall.remaining,
        })

        if calls:
            self.phase = Phase.PHASE1_RESPONSE
            await self.notify("call_available", {
                "calls": calls,
                "discard_tile": tile_id,
                "discard_seat": seat,
                "is_houtei": self.wall.remaining == 0,
            }, target_seat=opp_seat)
            return

        if self.wall.remaining == 0:
            await self._end_round_draw()
            return

        self.current_turn = opp_seat
        await self._do_draw()

    # ------------------------------------------------------------------
    # Phase 1 responses (from opponent after a discard)
    # ------------------------------------------------------------------

    async def response_pass(self, seat: int):
        """Opponent passes on a call opportunity."""
        if self.phase != Phase.PHASE1_RESPONSE or seat != self._response_target_seat() or not self.available_calls:
            return

        # Temporary furiten: if player could ron but chose to pass
        calls = self.available_calls
        if calls.get("can_ron"):
            self._temp_furiten.add(seat)

        # C1 fix: If this was a chankan pass, complete the kakan
        if calls.get("is_chankan") and self._pending_kakan:
            kakan_seat, kakan_tile, kakan_meld = self._pending_kakan
            self._pending_kakan = None
            self.available_calls = {}

            player_k = self.players[kakan_seat]
            player_k.hand.do_kakan(kakan_meld, kakan_tile)
            self._round_has_interruption = True
            self._total_kan_count += 1
            # 4-kan abort check for chankan path (M2 fix)
            if self._total_kan_count >= 4:
                p0_kans = sum(1 for m in self.players[0].hand.melds if m.meld_type.value in ('ankan', 'minkan', 'kakan'))
                p1_kans = sum(1 for m in self.players[1].hand.melds if m.meld_type.value in ('ankan', 'minkan', 'kakan'))
                if p0_kans > 0 and p1_kans > 0:
                    await self._end_round_draw(reason="four_kan_abort")
                    return
            rinshan = self.wall.draw_rinshan()

            await self.notify("kan_declared", {
                "seat": kakan_seat,
                "type": "kakan",
                "tiles": kakan_meld.tiles,
                "dora_indicators": self.wall.dora_indicators,
            })

            # Notify opponent about the rinshan draw
            await self.notify("opponent_draw", {
                "seat": kakan_seat,
                "wall_remaining": self.wall.remaining,
            }, target_seat=self.opponent_seat(kakan_seat))

            if rinshan is None:
                await self._end_round_draw()
                return

            player_k.hand.add_draw(rinshan)
            self._is_rinshan_draw = True
            can_tsumo = shanten_number(player_k.hand) == -1
            ankans_k = player_k.hand.can_ankan()
            kakans_k = player_k.hand.can_kakan()

            self.current_turn = kakan_seat
            self.phase = Phase.PHASE1_ACTION

            await self.notify("draw_tile", {
                "seat": kakan_seat,
                "tile": rinshan,
                "wall_remaining": self.wall.remaining,
                "actions": {
                    "must_discard": True,
                    "can_tsumo": can_tsumo,
                    "can_ankan": [[t for t in group] for group in ankans_k],
                    "can_kakan": [(m.to_dict(), extra) for m, extra in kakans_k],
                    "can_declare_tenpai": False,
                    "is_rinshan": True,
                },
            }, target_seat=kakan_seat)
            return

        self.available_calls = {}

        # If tenpai was declared, enter Phase 2 instead of continuing
        if self.tenpai_declarer is not None and self.tenpai_declarer == opp_seat:
            await self._enter_phase2()
            return

        # Check wall exhaustion
        if self.wall.remaining == 0:
            await self._end_round_draw()
            return

        # Next player draws
        self.current_turn = seat
        self.first_draw_done = True
        await self._do_draw()

    async def response_ron(self, seat: int):
        """Opponent declares ron."""
        if not self._response_action_allowed(seat, "can_ron"):
            return

        player = self.players[seat]
        discard_tile = self.last_discard
        if discard_tile is None:
            return

        is_chankan = self.available_calls.get("is_chankan", False)
        is_houtei = self.wall.remaining == 0

        score = calculate_score(
            hand=player.hand,
            win_tile=discard_tile,
            is_tsumo=False,
            is_dealer=player.is_dealer,
            round_wind_tt=self.round_wind_tt,
            player_wind_tt=27 if player.is_dealer else 28,
            dora_indicators=self.wall.dora_indicators,
            is_chankan=is_chankan,
            is_houtei=is_houtei,
            is_riichi=player.declared_riichi,
            is_daburu_riichi=player.declared_daburu_riichi,
            is_ippatsu=seat in self._ippatsu_pending,
            ura_dora_indicators=self.wall.get_uradora_indicators() if player.declared_riichi else None,
        )

        if score is None:
            return

        # Add the win tile to hand for display
        player.hand.closed.append(discard_tile)
        player.hand.closed.sort(key=tile_type)

        await self._end_round_win(seat, score, is_tsumo=False, win_tile=discard_tile)

    async def response_chi(self, seat: int, own_tiles: list[int]):
        """Opponent calls chi."""
        if not self._response_action_allowed(seat, "can_chi"):
            return
        player = self.players[seat]
        discard_tile = self.last_discard
        if discard_tile is None:
            return

        # Validate
        chi_options = self.available_calls.get("can_chi") or []
        valid = any(set(opt) == set(own_tiles) for opt in chi_options)
        if not valid:
            return

        self._clear_ippatsu()
        self._round_has_interruption = True
        player.hand.do_chi(own_tiles, discard_tile)
        self._mark_discard_called(self.last_discard_seat, discard_tile)
        self.available_calls = {}
        self.first_draw_done = True

        await self.notify("call_made", {
            "seat": seat,
            "type": "chi",
            "tiles": sorted(own_tiles + [discard_tile], key=tile_type),
            "called_tile": discard_tile,
        })

        # After chi, the caller must discard
        self.current_turn = seat
        self.phase = Phase.PHASE1_ACTION

        await self.notify("must_discard", {
            "seat": seat,
        }, target_seat=seat)

    async def response_pon(self, seat: int):
        """Opponent calls pon."""
        if not self._response_action_allowed(seat, "can_pon"):
            return
        player = self.players[seat]
        discard_tile = self.last_discard
        if discard_tile is None:
            return

        own_tiles = self.available_calls.get("can_pon")
        if own_tiles is None:
            return

        self._clear_ippatsu()
        self._round_has_interruption = True
        player.hand.do_pon(own_tiles, discard_tile)
        self._mark_discard_called(self.last_discard_seat, discard_tile)
        self.available_calls = {}
        self.first_draw_done = True

        await self.notify("call_made", {
            "seat": seat,
            "type": "pon",
            "tiles": own_tiles + [discard_tile],
            "called_tile": discard_tile,
        })

        self.current_turn = seat
        self.phase = Phase.PHASE1_ACTION

        await self.notify("must_discard", {
            "seat": seat,
        }, target_seat=seat)

    async def response_minkan(self, seat: int):
        """Opponent calls open kan (大明杠)."""
        if not self._response_action_allowed(seat, "can_minkan"):
            return
        player = self.players[seat]
        discard_tile = self.last_discard
        if discard_tile is None:
            return

        own_tiles = self.available_calls.get("can_minkan")
        if own_tiles is None:
            return

        self._clear_ippatsu()
        self._round_has_interruption = True
        player.hand.do_minkan(own_tiles, discard_tile)
        self._mark_discard_called(self.last_discard_seat, discard_tile)
        self.available_calls = {}
        self.first_draw_done = True
        self._total_kan_count += 1

        # 4-kan abort check
        if self._total_kan_count >= 4:
            p0_kans = sum(1 for m in self.players[0].hand.melds if m.meld_type.value in ('ankan', 'minkan', 'kakan'))
            p1_kans = sum(1 for m in self.players[1].hand.melds if m.meld_type.value in ('ankan', 'minkan', 'kakan'))
            if p0_kans > 0 and p1_kans > 0:
                await self.notify("kan_declared", {
                    "seat": seat,
                    "type": "minkan",
                    "tiles": own_tiles + [discard_tile],
                    "dora_indicators": self.wall.dora_indicators,
                })
                await self._end_round_draw(reason="four_kan_abort")
                return

        rinshan = self.wall.draw_rinshan()

        await self.notify("kan_declared", {
            "seat": seat,
            "type": "minkan",
            "tiles": own_tiles + [discard_tile],
            "dora_indicators": self.wall.dora_indicators,
        })

        if rinshan is None:
            await self._end_round_draw()
            return

        player.hand.add_draw(rinshan)
        self._is_rinshan_draw = True
        can_tsumo = shanten_number(player.hand) == -1
        ankans = player.hand.can_ankan()
        kakans = player.hand.can_kakan()

        self.current_turn = seat
        self.phase = Phase.PHASE1_ACTION

        # Notify opponent about the rinshan draw
        await self.notify("opponent_draw", {
            "seat": seat,
            "wall_remaining": self.wall.remaining,
        }, target_seat=self.opponent_seat(seat))

        await self.notify("draw_tile", {
            "seat": seat,
            "tile": rinshan,
            "wall_remaining": self.wall.remaining,
            "actions": {
                "must_discard": True,
                "can_tsumo": can_tsumo,
                "can_ankan": [[t for t in group] for group in ankans],
                "can_kakan": [(m.to_dict(), extra) for m, extra in kakans],
                "can_declare_tenpai": False,
                "is_rinshan": True,
            },
        }, target_seat=seat)

    # ------------------------------------------------------------------
    # Phase 2: tenpai declared → guess & draw cycle
    # ------------------------------------------------------------------

    async def _enter_phase2(self):
        """Transition to Phase 2 after tenpai declaration + discard."""
        self.phase = Phase.PHASE2_GUESS
        self.phase2_draw_count = 0
        opp_seat = self.opponent_seat(self.tenpai_declarer)
        self.current_turn = opp_seat

        await self.notify("phase2_start", {
            "tenpai_declarer": self.tenpai_declarer,
            "guesser": opp_seat,
        })

        await self.notify("phase2_guess_request", self._phase2_guess_request_payload(opp_seat), target_seat=opp_seat)

    async def phase2_guess(self, seat: int, guessed_types: list[int]):
        """Opponent guesses up to 2 tile types, depending on remaining selectable tiles."""
        if self.phase != Phase.PHASE2_GUESS:
            return
        if seat == self.tenpai_declarer:
            return

        selectable_types = set(self._phase2_guess_selectable_types(seat))
        required_count = min(2, len(selectable_types))
        if len(guessed_types) != required_count:
            await self.notify("phase2_guess_request", self._phase2_guess_request_payload(seat, invalid=True), target_seat=seat)
            return
        if len(set(guessed_types)) != len(guessed_types):
            await self.notify("phase2_guess_request", self._phase2_guess_request_payload(seat, invalid=True), target_seat=seat)
            return
        if not all(0 <= t < NUM_TILE_TYPES for t in guessed_types):
            await self.notify("phase2_guess_request", self._phase2_guess_request_payload(seat, invalid=True), target_seat=seat)
            return

        guessed_history = self.phase2_guessed_types_by_seat.setdefault(seat, set())
        if any(t not in selectable_types for t in guessed_types):
            await self.notify("phase2_guess_request", self._phase2_guess_request_payload(seat, invalid=True), target_seat=seat)
            return

        guessed_history.update(guessed_types)

        declarer = self.players[self.tenpai_declarer]
        waits = set(declarer.tenpai_waits)

        hit = bool(waits & set(guessed_types))

        await self.notify("phase2_guess_result", {
            "guesser": seat,
            "guessed": guessed_types,
            "guessed_names": [tile_type_name(t) for t in guessed_types],
            "already_guessed": sorted(guessed_history),
            "hit": hit,
            "skipped": len(guessed_types) == 0,
        })

        if hit:
            # Guess hit → round is a draw (流局)
            await self._end_round_draw(reason="phase2_guess_hit")
        else:
            # Declarer draws up to 5 tiles
            self.phase2_draw_count = 0
            await self._phase2_draw_cycle()

    async def _phase2_draw_cycle(self):
        """Start Phase 2 draw cycle. Frontend drives via phase2_next_draw messages."""
        self.phase = Phase.PHASE2_DRAW
        self.phase2_draw_count = 0
        self.current_turn = self.tenpai_declarer

        # Notify both players that the draw cycle is starting; frontend triggers each draw
        await self.notify("phase2_draw_cycle_start", {
            "declarer": self.tenpai_declarer,
            "draws_remaining": 5,
        })

    def _phase2_tsumo_score(self, declarer: PlayerState) -> ScoreResult | None:
        win_tile = declarer.hand.draw_tile
        if win_tile is None or shanten_number(declarer.hand) != -1:
            return None

        return calculate_score(
            hand=declarer.hand,
            win_tile=win_tile,
            is_tsumo=True,
            is_dealer=declarer.is_dealer,
            round_wind_tt=self.round_wind_tt,
            player_wind_tt=27 if declarer.is_dealer else 28,
            dora_indicators=self.wall.dora_indicators,
            is_rinshan=self._is_rinshan_draw,
            is_haitei=self.wall.remaining == 0,
            is_riichi=declarer.declared_riichi,
            is_daburu_riichi=declarer.declared_daburu_riichi,
            is_ippatsu=declarer.seat in self._ippatsu_pending,
            ura_dora_indicators=self.wall.get_uradora_indicators() if declarer.declared_riichi else None,
        )

    def _phase2_actions_payload(self, declarer: PlayerState) -> dict:
        draw_tile = declarer.hand.draw_tile
        return {
            "must_discard": True,
            "can_tsumo": self._phase2_tsumo_score(declarer) is not None,
            "tenpai_discards": [draw_tile] if draw_tile is not None else [],
            "can_ankan": [[t for t in group] for group in self._locked_tenpai_ankan_options(declarer)],
            "can_kakan": [(m.to_dict(), extra) for m, extra in self._locked_tenpai_kakan_options(declarer)],
            "can_declare_tenpai": False,
            "can_declare_riichi": False,
            "is_phase2": True,
        }

    async def action_phase2_discard(self, seat: int, tile_id: int):
        """Tenpai declarer discards during Phase 2 without changing the locked hand shape."""
        if self.phase != Phase.PHASE2_ACTION or seat != self.tenpai_declarer or self.current_turn != seat:
            return

        declarer = self.players[seat]
        if tile_id not in declarer.hand.closed or tile_id != declarer.hand.draw_tile:
            return

        declarer.hand.closed.remove(tile_id)
        still_tenpai = self._locked_tenpai_signature(declarer.hand) == tuple(sorted(declarer.tenpai_waits))
        declarer.hand.closed.append(tile_id)
        declarer.hand.closed.sort(key=tile_type)
        if not still_tenpai:
            return

        hidden_discard = self._phase2_tsumo_score(declarer) is not None
        declarer.hand.discard(tile_id, hidden=hidden_discard)
        declarer.tenpai_waits = self._safe_waiting_tiles(declarer.hand)
        declarer.is_furiten = is_furiten(declarer.hand, declarer.tenpai_waits) if declarer.tenpai_waits else False
        self.last_discard = tile_id
        self.last_discard_seat = seat
        self.first_draw_done = True
        self.available_calls = {}
        self._clear_ippatsu(seat)

        draws_remaining = max(0, 5 - self.phase2_draw_count)
        payload = {
            "declarer": seat,
            "draws_remaining": draws_remaining,
            "hidden_discard": hidden_discard,
        }
        if not hidden_discard:
            payload["tile"] = tile_id
        await self.notify("phase2_discard", payload)

        if self.phase2_draw_count >= 5:
            self.phase = Phase.PHASE2_GUESS
            opp_seat = self.opponent_seat(self.tenpai_declarer)
            self.current_turn = opp_seat
            await self.notify("phase2_guess_request", self._phase2_guess_request_payload(opp_seat, retry=True), target_seat=opp_seat)
            return

        self.phase = Phase.PHASE2_DRAW
        self.current_turn = seat

    async def phase2_next_draw(self, seat: int):
        """Frontend requests the next Phase 2 draw (step-driven, no sleep)."""
        if self.phase != Phase.PHASE2_DRAW or seat != self.tenpai_declarer:
            return

        async with self._phase2_draw_lock:
            if self.phase != Phase.PHASE2_DRAW or seat != self.tenpai_declarer:
                return
            if self.phase2_draw_count >= 5:
                return

            declarer = self.players[self.tenpai_declarer]

            tile = self.wall.draw()
            if tile is None:
                await self._end_round_draw()
                return

            self.phase2_draw_count += 1
            declarer.hand.add_draw(tile)

            await self.notify("phase2_draw", {
                "declarer": self.tenpai_declarer,
                "draw_number": self.phase2_draw_count,
                "wall_remaining": self.wall.remaining,
            })

            self.phase = Phase.PHASE2_ACTION
            self.current_turn = self.tenpai_declarer
            await self.notify("draw_tile", {
                "seat": self.tenpai_declarer,
                "tile": tile,
                "wall_remaining": self.wall.remaining,
                "phase": Phase.PHASE2_ACTION.value,
                "actions": self._phase2_actions_payload(declarer),
                "waiting_tiles": [tile_type_name(tt) for tt in declarer.tenpai_waits],
            }, target_seat=self.tenpai_declarer)

    # ------------------------------------------------------------------
    # Round end
    # ------------------------------------------------------------------

    async def _end_round_win(self, winner_seat: int, score: ScoreResult,
                              is_tsumo: bool, win_tile: int):
        """Handle a winning hand (tsumo or ron)."""
        self.phase = Phase.ROUND_END
        self.current_turn = -1
        winner = self.players[winner_seat]
        loser_seat = self.opponent_seat(winner_seat)
        loser = self.players[loser_seat]

        base_transfer = points_transfer_2p(score, is_tsumo, winner.is_dealer)
        honba_bonus = self.honba_count * 300
        riichi_bonus = self.riichi_sticks * 1000
        total_transfer = base_transfer + honba_bonus

        winner.points += total_transfer + riichi_bonus
        loser.points -= total_transfer

        self.round_result = RoundResult(
            result_type="tsumo" if is_tsumo else "ron",
            winner=winner_seat,
            loser=loser_seat,
            score=score,
            points_delta={
                winner_seat: total_transfer + riichi_bonus,
                loser_seat: -total_transfer,
            },
            details={
                "base_transfer": base_transfer,
                "honba_bonus": honba_bonus,
                "riichi_bonus": riichi_bonus,
            },
        )

        await self.notify("round_result", {
            "type": self.round_result.result_type,
            "winner": winner_seat,
            "winner_name": winner.username,
            "loser": loser_seat,
            "win_tile": win_tile,
            "hand": winner.hand.to_dict(),
            "score": score.to_dict(),
            "dora_indicators": self.wall.dora_indicators,
            "uradora_indicators": self.wall.get_uradora_indicators() if winner.declared_riichi else [],
            "points_transfer": total_transfer,
            "points_delta": self.round_result.points_delta,
            "honba_count": self.honba_count,
            "riichi_sticks": self.riichi_sticks,
            "honba_bonus": honba_bonus,
            "riichi_bonus": riichi_bonus,
            "points": {p.seat: p.points for p in self.players},
        })

        if winner.is_dealer:
            self.honba_count += 1
        else:
            self.dealer_seat = self.opponent_seat(self.dealer_seat)
            self.honba_count = 0

        self.riichi_sticks = 0

        await self._check_game_over_or_continue()

    async def _end_round_draw(self, reason: str = "exhaustive"):
        """Handle a draw (流局)."""
        self.phase = Phase.ROUND_END
        self.current_turn = -1

        p0 = self.players[0]
        p1 = self.players[1]

        delta = {0: 0, 1: 0}
        revealed_hand = None
        revealed_seat = None
        revealed_name = None
        nagashi_winners: list[int] = []
        nagashi_names: list[str] = []
        nagashi_winner_seat: int | None = None
        nagashi_score: ScoreResult | None = None
        nagashi_points_transfer = 0
        nagashi_honba_bonus = 0
        nagashi_riichi_bonus = 0
        draw_dora_indicators = list(self.wall.dora_indicators)
        draw_uradora_indicators = self.wall.get_uradora_indicators() if any(player.declared_riichi for player in self.players) else []

        if reason == "exhaustive":
            nagashi_scores: dict[int, ScoreResult] = {}
            for winner_seat in self._nagashi_mangan_qualifiers():
                winner = self.players[winner_seat]
                score = calculate_score(
                    hand=winner.hand,
                    win_tile=None,
                    is_tsumo=True,
                    is_dealer=winner.is_dealer,
                    round_wind_tt=self.round_wind_tt,
                    player_wind_tt=27 if winner.is_dealer else 28,
                    dora_indicators=[],
                    is_nagashi_mangan=True,
                )
                if score is not None:
                    nagashi_scores[winner_seat] = score

            nagashi_winners = sorted(nagashi_scores)
            if nagashi_winners:
                nagashi_names = [self.players[winner_seat].username for winner_seat in nagashi_winners]
                if len(nagashi_winners) == 1:
                    nagashi_winner_seat = nagashi_winners[0]
                    winner = self.players[nagashi_winner_seat]
                    loser_seat = self.opponent_seat(nagashi_winner_seat)
                    nagashi_score = nagashi_scores[nagashi_winner_seat]
                    base_transfer = points_transfer_2p(nagashi_score, True, winner.is_dealer)
                    nagashi_honba_bonus = self.honba_count * 300
                    nagashi_riichi_bonus = self.riichi_sticks * 1000
                    nagashi_points_transfer = base_transfer + nagashi_honba_bonus
                    delta[nagashi_winner_seat] += nagashi_points_transfer + nagashi_riichi_bonus
                    delta[loser_seat] -= nagashi_points_transfer
                else:
                    # 2-player simultaneous nagashi mangan is rare and non-standard.
                    # Keep settlement symmetric and leave honba/riichi sticks unresolved.
                    for winner_seat in nagashi_winners:
                        winner = self.players[winner_seat]
                        transfer = points_transfer_2p(nagashi_scores[winner_seat], True, winner.is_dealer)
                        loser_seat = self.opponent_seat(winner_seat)
                        delta[winner_seat] += transfer
                        delta[loser_seat] -= transfer
                reason = "nagashi_mangan"

        if reason == "phase2_guess_hit":
            # Guess hit: round ends in an immediate draw with no point exchange.
            declarer_seat = self.tenpai_declarer
            p0_tenpai = self.players[0].declared_tenpai or self._safe_is_tenpai(p0.hand)
            p1_tenpai = self.players[1].declared_tenpai or self._safe_is_tenpai(p1.hand)
            revealed_seat = declarer_seat
            revealed_name = self.players[declarer_seat].username
            revealed_hand = self._serialize_result_hand(self.players[declarer_seat].hand)
        elif reason == "nagashi_mangan":
            p0_tenpai = self._safe_is_tenpai(p0.hand)
            p1_tenpai = self._safe_is_tenpai(p1.hand)
        else:
            # Normal exhaustive draw: tenpai noten payments (3000 transfer)
            p0_tenpai = self._safe_is_tenpai(p0.hand)
            p1_tenpai = self._safe_is_tenpai(p1.hand)
            if p0_tenpai and not p1_tenpai:
                delta[0] = 3000
                delta[1] = -3000
            elif p1_tenpai and not p0_tenpai:
                delta[1] = 3000
                delta[0] = -3000
            # Both tenpai or both noten → no transfer

        p0.points += delta[0]
        p1.points += delta[1]

        self.round_result = RoundResult(
            result_type="draw",
            points_delta=delta,
            details={
                "reason": reason,
                "p0_tenpai": p0_tenpai,
                "p1_tenpai": p1_tenpai,
                "revealed_seat": revealed_seat,
                "revealed_name": revealed_name,
                "revealed_hand": revealed_hand,
                "nagashi_winners": nagashi_winners,
                "nagashi_names": nagashi_names,
                "winner": nagashi_winner_seat,
                "score": nagashi_score.to_dict() if nagashi_score else None,
                "points_transfer": nagashi_points_transfer,
                "honba_bonus": nagashi_honba_bonus,
                "riichi_bonus": nagashi_riichi_bonus,
                "dora_indicators": draw_dora_indicators,
                "uradora_indicators": draw_uradora_indicators,
            },
        )

        await self.notify("round_result", {
            "type": "draw",
            "reason": reason,
            "tenpai": {0: p0_tenpai, 1: p1_tenpai},
            "points_delta": delta,
            "honba_count": self.honba_count,
            "riichi_sticks": self.riichi_sticks,
            "points": {p.seat: p.points for p in self.players},
            "revealed_seat": revealed_seat,
            "revealed_name": revealed_name,
            "revealed_hand": revealed_hand,
            "nagashi_winners": nagashi_winners,
            "nagashi_names": nagashi_names,
            "winner": nagashi_winner_seat,
            "winner_name": self.players[nagashi_winner_seat].username if nagashi_winner_seat is not None else None,
            "score": nagashi_score.to_dict() if nagashi_score else None,
            "dora_indicators": draw_dora_indicators,
            "uradora_indicators": draw_uradora_indicators,
            "points_transfer": nagashi_points_transfer,
            "honba_bonus": nagashi_honba_bonus,
            "riichi_bonus": nagashi_riichi_bonus,
        })

        if reason == "nagashi_mangan" and nagashi_winner_seat is not None:
            if self.players[nagashi_winner_seat].is_dealer:
                self.honba_count += 1
            else:
                self.dealer_seat = self.opponent_seat(self.dealer_seat)
                self.honba_count = 0
            self.riichi_sticks = 0
        else:
            # Dealer stays if they are tenpai
            dealer = self.players[self.dealer_seat]
            if self._safe_is_tenpai(dealer.hand):
                self.honba_count += 1
            else:
                self.dealer_seat = self.opponent_seat(self.dealer_seat)
                self.honba_count = 0

        await self._check_game_over_or_continue()

    async def _check_game_over_or_continue(self):
        """Check if the game should end, otherwise start next round."""
        # Game over conditions:
        # 1. Current round is already marked as the last round
        # 2. Match timer has reached the limit by the end of this round
        # 3. A player has <= 0 points
        game_over = False
        timer_expired = False
        if self.game_start_time:
            elapsed = time.time() - self.game_start_time
            timer_expired = elapsed >= self.timer_minutes * 60

        if self.is_last_round or timer_expired:
            game_over = True
        for p in self.players:
            if p.points <= 0:
                game_over = True

        if game_over:
            self.phase = Phase.GAME_OVER
            self.game_over = True
            self.current_turn = -1

            winner_seat = 0 if self.players[0].points >= self.players[1].points else 1
            if self.riichi_sticks > 0:
                self.players[winner_seat].points += self.riichi_sticks * 1000
                self.riichi_sticks = 0
            await self.notify("game_over", {
                "winner": winner_seat,
                "winner_name": self.players[winner_seat].username,
                "final_points": {p.seat: p.points for p in self.players},
                "honba_count": self.honba_count,
                "riichi_sticks": self.riichi_sticks,
            })
        else:
            # Wait for both players to confirm ready
            self._ready.clear()
            self.phase = Phase.ROUND_END

    async def player_ready(self, seat: int):
        """Player confirms ready for next round."""
        if self.phase != Phase.ROUND_END:
            return
        if seat in self._ready:
            return
        self._ready.add(seat)
        await self.notify("round_ready", {
            "ready_seats": sorted(self._ready),
        })
        if len(self._ready) >= 2:
            self._ready.clear()
            await self.start_round()

    # ------------------------------------------------------------------
    # State serialization
    # ------------------------------------------------------------------

    def _serialized_actions_for_player(self, seat: int) -> dict:
        player = self.players[seat]
        if player is None:
            return {}

        if self.phase == Phase.PHASE1_ACTION and seat == self.current_turn:
            if player.hand.draw_tile is None:
                return {"must_discard": True}

            if seat in self._pending_damaten:
                return {
                    "must_discard": True,
                    "tenpai_discards": self._tenpai_declaration_discards(player.hand),
                    "tenpai_mode": "damaten",
                }

            if player.declared_tenpai and self.tenpai_declarer == seat:
                return {
                    "must_discard": True,
                    "tenpai_discards": self._tenpai_declaration_discards(player.hand),
                    "tenpai_mode": "riichi" if player.declared_riichi else "public_tenpai",
                }

            can_tsumo = shanten_number(player.hand) == -1
            ankans = self._phase1_ankan_options(player)
            kakans = self._phase1_kakan_options(player)
            can_declare_tenpai = self._can_declare_tenpai(player)
            can_declare_riichi = self._can_declare_riichi(player)
            actions = {
                "must_discard": True,
                "can_tsumo": can_tsumo,
                "can_ankan": [[t for t in group] for group in ankans],
                "can_kakan": [(m.to_dict(), extra) for m, extra in kakans],
                "can_declare_tenpai": can_declare_tenpai,
                "can_declare_riichi": can_declare_riichi,
                "can_declare_damaten": can_declare_riichi,
                "is_haitei": self.wall.remaining == 0,
            }
            if self._is_rinshan_draw:
                actions["is_rinshan"] = True
            return actions

        if self.phase == Phase.PHASE2_ACTION and seat == self.current_turn and seat == self.tenpai_declarer:
            return self._phase2_actions_payload(player)

        if self.phase == Phase.PHASE1_RESPONSE and seat != self.last_discard_seat and self.available_calls:
            actions = dict(self.available_calls)
            if self.last_discard is not None:
                actions["_discard_tile"] = self.last_discard
            if self.last_discard_seat is not None:
                actions["_discard_seat"] = self.last_discard_seat
            return actions

        return {}

    def get_state_for_player(self, seat: int) -> dict:
        """Get full game state from a player's perspective (hides opponent hand)."""
        opp = self.opponent_seat(seat)
        player = self.players[seat]
        opponent = self.players[opp]

        my_waiting_tile_names: list[str] = []
        # waiting_tiles/is_tenpai requires legal tile counts; in waiting-room phase hand can be empty.
        if player and len(player.hand.closed) in (13, 14):
            try:
                if self._safe_is_tenpai(player.hand):
                    my_waiting_tile_names = [tile_type_name(tt) for tt in self._safe_waiting_tiles(player.hand)]
            except ValueError:
                my_waiting_tile_names = []

        if opponent is None:
            # Opponent not yet joined
            return {
                "phase": self.phase.value,
                "round_number": self.round_number,
                "dealer_seat": self.dealer_seat,
                "current_turn": self.current_turn,
                "my_seat": seat,
                "my_hand": player.hand.to_dict(hide_tiles=False) if player else {"closed": [], "closed_count": 0, "melds": [], "discards": [], "draw_tile": None},
                "my_points": player.points if player else 25000,
                "my_declared_tenpai": False,
                "my_declared_riichi": False,
                "opponent_hand": {"closed": [], "closed_count": 0, "melds": [], "discards": [], "draw_tile": None},
                "opponent_points": 25000,
                "opponent_name": "等待中...",
                "opponent_declared_tenpai": False,
                "opponent_declared_riichi": False,
                "wall": self.wall.to_dict(),
                "is_last_round": self.is_last_round,
                "timer_remaining": self.get_timer_remaining(),
                "tenpai_declarer": self.tenpai_declarer,
                "honba_count": self.honba_count,
                "riichi_sticks": self.riichi_sticks,
                "actions": self._serialized_actions_for_player(seat),
                "round_ready_seats": sorted(self._ready),
                "phase2_guessed_types": sorted(self.phase2_guessed_types_by_seat.get(seat, set())),
            }

        elapsed = 0
        remaining_time = self.timer_minutes * 60
        if self.game_start_time:
            elapsed = time.time() - self.game_start_time
            remaining_time = max(0, self.timer_minutes * 60 - elapsed)

        return {
            "phase": self.phase.value,
            "round_number": self.round_number,
            "dealer_seat": self.dealer_seat,
            "current_turn": self.current_turn,
            "my_seat": seat,
            "my_hand": player.hand.to_dict(hide_tiles=False),
            "my_points": player.points,
            "my_declared_tenpai": player.declared_tenpai,
            "my_declared_riichi": player.declared_riichi,
            "my_waiting_tiles": my_waiting_tile_names,
            "opponent_hand": opponent.hand.to_dict(hide_tiles=True),
            "opponent_points": opponent.points,
            "opponent_name": opponent.username,
            "opponent_declared_tenpai": opponent.declared_tenpai,
            "opponent_declared_riichi": opponent.declared_riichi,
            "wall": self.wall.to_dict(),
            "is_last_round": self.is_last_round,
            "timer_remaining": int(remaining_time),
            "tenpai_declarer": self.tenpai_declarer,
            "honba_count": self.honba_count,
            "riichi_sticks": self.riichi_sticks,
            "actions": self._serialized_actions_for_player(seat),
            "round_ready_seats": sorted(self._ready),
            "phase2_draw_count": self.phase2_draw_count,
            "phase2_guessed_types": sorted(self.phase2_guessed_types_by_seat.get(seat, set())),
        }

    def _round_start_data(self) -> dict:
        return {
            "round_number": self.round_number,
            "dealer_seat": self.dealer_seat,
            "current_turn": self.current_turn,
            "wall_remaining": self.wall.remaining,
            "dora_indicators": self.wall.dora_indicators,
            "is_last_round": self.is_last_round,
            "honba_count": self.honba_count,
            "riichi_sticks": self.riichi_sticks,
        }

    def get_timer_remaining(self) -> int:
        if self.game_start_time is None:
            return self.timer_minutes * 60
        elapsed = time.time() - self.game_start_time
        return max(0, int(self.timer_minutes * 60 - elapsed))
