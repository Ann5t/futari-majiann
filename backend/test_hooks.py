from collections import Counter
from typing import Any

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from auth import get_http_user
from game.engine import Phase
from game.melds import Meld, MeldType
from game.room import room_manager
from game.tenpai import waiting_tiles, is_tenpai
from game.tiles import all_tile_ids, ids_of_type, red_dora_id_for_type, tile_type, tile_type_from_str
from game.wall import DEAD_WALL_SIZE


router = APIRouter(prefix="/api/test")


@router.post("/reset-rooms")
async def reset_rooms():
    room_manager.reset()
    return {"ok": True}


class Phase2GuessRequest(BaseModel):
    already_guessed: list[int]
    tenpai_declarer: int | None = None
    message: str = "5次摸牌结束，未和牌。请再次选择2张牌进行猜测。"
    declarer_closed: list[str] | None = None
    declarer_melds: list["TestMeldRequest"] | None = None
    guesser_closed: list[str] | None = None
    guesser_melds: list["TestMeldRequest"] | None = None
    wall_draw_sequence: list[str] | None = None
    dora_indicator: str | None = None
    rinshan_sequence: list[str] | None = None


class TestMeldRequest(BaseModel):
    type: str
    tiles: list[str]
    called_index: int | None = None


Phase2GuessRequest.model_rebuild()


class Phase1ActionStateRequest(BaseModel):
    actor_closed: list[str]
    actor_melds: list["TestMeldRequest"] | None = None
    actor_draw: str
    opponent_closed: list[str]
    opponent_melds: list["TestMeldRequest"] | None = None
    dora_indicator: str | None = None
    actor_points: int | None = None
    opponent_points: int | None = None


Phase1ActionStateRequest.model_rebuild()


class GameOverStateRequest(BaseModel):
    winner: int
    seat0_points: int
    seat1_points: int
    honba_count: int = 0
    riichi_sticks: int = 0
    round_result: dict[str, Any] | None = None


def _normalize_tile_name(name: str) -> str:
    return name.strip().lower().replace("東", "东").replace(" ", "")


def _validate_tile_name_counts(tile_names: list[str]):
    counts = Counter(tile_type_from_str(tile_name) for tile_name in tile_names)
    for tt, count in counts.items():
        if count > 4:
            raise HTTPException(status_code=400, detail=f"牌型 {tt} 超过4张")

    red_counts = Counter(tile_name for tile_name in tile_names if len(tile_name) == 2 and tile_name[0] == '0' and tile_name[1] in 'mps')
    for tile_name, count in red_counts.items():
        if count > 1:
            raise HTTPException(status_code=400, detail=f"红宝牌 {tile_name} 超过1张")


def _allocate_tile_ids(tile_names: list[str], available_by_type: dict[int, list[int]]) -> list[int]:
    allocated: list[int] = []
    for tile_name in tile_names:
        try:
            tile_type_index = tile_type_from_str(tile_name)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        bucket = available_by_type.get(tile_type_index)
        if not bucket:
            raise HTTPException(status_code=400, detail=f"牌 {tile_name} 已无可用张")

        if len(tile_name) == 2 and tile_name[0] == '0' and tile_name[1] in 'mps':
            red_id = red_dora_id_for_type(tile_type_index)
            if red_id is None or red_id not in bucket:
                raise HTTPException(status_code=400, detail=f"红宝牌 {tile_name} 已无可用张")
            bucket.remove(red_id)
            allocated.append(red_id)
            continue

        allocated.append(bucket.pop(0))
    return allocated


def _build_available_tiles() -> dict[int, list[int]]:
    available_by_type: dict[int, list[int]] = {}
    for tt in range(34):
        available_by_type[tt] = list(ids_of_type(tt))
    return available_by_type


def _validate_meld_request(meld_type: MeldType, tile_names: list[str]):
    tile_types = [tile_type_from_str(tile_name) for tile_name in tile_names]

    if meld_type == MeldType.CHI:
        if len(tile_types) != 3:
            raise HTTPException(status_code=400, detail="chi 副露必须正好3张")
        if any(tt >= 27 for tt in tile_types):
            raise HTTPException(status_code=400, detail="chi 只能使用数牌")
        ordered = sorted(tile_types)
        if not (ordered[1] == ordered[0] + 1 and ordered[2] == ordered[1] + 1):
            raise HTTPException(status_code=400, detail="chi 副露必须是顺子")
        if ordered[0] // 9 != ordered[2] // 9:
            raise HTTPException(status_code=400, detail="chi 副露不能跨花色")
        return

    expected_len = 3 if meld_type == MeldType.PON else 4
    if len(tile_types) != expected_len:
        raise HTTPException(status_code=400, detail=f"{meld_type.value} 副露张数不正确")
    if len(set(tile_types)) != 1:
        raise HTTPException(status_code=400, detail=f"{meld_type.value} 副露必须同种牌")


def _allocate_melds(meld_specs: list[TestMeldRequest] | None, available_by_type: dict[int, list[int]]) -> list[Meld]:
    melds: list[Meld] = []
    for spec in meld_specs or []:
        try:
            meld_type = MeldType(spec.type)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"不支持的副露类型: {spec.type}") from exc

        tile_names = [_normalize_tile_name(tile) for tile in spec.tiles]
        _validate_meld_request(meld_type, tile_names)
        tile_ids = _allocate_tile_ids(tile_names, available_by_type)

        if meld_type == MeldType.ANKAN:
            called_tile = None
        else:
            called_index = spec.called_index if spec.called_index is not None else len(tile_ids) - 1
            if called_index < 0 or called_index >= len(tile_ids):
                raise HTTPException(status_code=400, detail="副露 called_index 超出范围")
            called_tile = tile_ids[called_index]

        melds.append(Meld(meld_type, tile_ids, called_tile=called_tile))

    return melds


def _count_kan_melds(*meld_groups: list[Meld]) -> int:
    kan_types = {MeldType.ANKAN, MeldType.MINKAN, MeldType.KAKAN}
    return sum(1 for meld_group in meld_groups for meld in meld_group if meld.meld_type in kan_types)


def _build_dead_wall(
    available_by_type: dict[int, list[int]],
    dora_indicator: str | None,
    rinshan_sequence: list[str] | None = None,
) -> tuple[list[int], int]:
    rinshan_ids: list[int] = []
    if rinshan_sequence:
        rinshan_ids = _allocate_tile_ids(rinshan_sequence, available_by_type)
        if len(rinshan_ids) > DEAD_WALL_SIZE:
            raise HTTPException(status_code=400, detail="rinshan_sequence 过长")

    remaining_pool = [tile_id for tt in sorted(available_by_type) for tile_id in available_by_type[tt]]
    rinshan_fill_count = max(0, 4 - len(rinshan_ids))
    if len(remaining_pool) < rinshan_fill_count:
        raise HTTPException(status_code=400, detail="剩余牌不足以构造岭上牌")
    rinshan_fill = remaining_pool[:rinshan_fill_count]
    for tile_id in rinshan_fill:
        available_by_type[tile_type(tile_id)].remove(tile_id)

    if dora_indicator:
        indicator_tile_id = _allocate_tile_ids([dora_indicator], available_by_type)[0]
    else:
        first_type = min(tt for tt, tiles in available_by_type.items() if tiles)
        indicator_tile_id = available_by_type[first_type].pop(0)

    remaining_pool = [tile_id for tt in sorted(available_by_type) for tile_id in available_by_type[tt]]
    if len(remaining_pool) < DEAD_WALL_SIZE - 5:
        raise HTTPException(status_code=400, detail="剩余牌不足以构造王牌")

    dead_wall_fill = remaining_pool[: DEAD_WALL_SIZE - 5]
    for tile_id in dead_wall_fill:
        available_by_type[tile_type(tile_id)].remove(tile_id)

    dead_wall = rinshan_ids + rinshan_fill + [indicator_tile_id] + dead_wall_fill
    return dead_wall, indicator_tile_id


def _setup_controlled_phase1_action(engine, actor_seat: int, req: Phase1ActionStateRequest):
    opponent_seat = engine.opponent_seat(actor_seat)

    actor_tiles = [_normalize_tile_name(tile) for tile in req.actor_closed]
    actor_meld_tiles = [_normalize_tile_name(tile) for meld in (req.actor_melds or []) for tile in meld.tiles]
    actor_draw = _normalize_tile_name(req.actor_draw)
    opponent_tiles = [_normalize_tile_name(tile) for tile in req.opponent_closed]
    opponent_meld_tiles = [_normalize_tile_name(tile) for meld in (req.opponent_melds or []) for tile in meld.tiles]
    dora_indicator = _normalize_tile_name(req.dora_indicator) if req.dora_indicator else None

    if len(actor_tiles) + len(actor_meld_tiles) != 13:
        raise HTTPException(status_code=400, detail="actor_closed 加 actor_melds 必须合计正好13张")
    if len(opponent_tiles) + len(opponent_meld_tiles) != 13:
        raise HTTPException(status_code=400, detail="opponent_closed 加 opponent_melds 必须合计正好13张")

    combined_tile_names = actor_tiles + actor_meld_tiles + [actor_draw] + opponent_tiles + opponent_meld_tiles
    if dora_indicator:
        combined_tile_names.append(dora_indicator)
    _validate_tile_name_counts(combined_tile_names)

    available_by_type = _build_available_tiles()
    actor_closed_ids = _allocate_tile_ids(actor_tiles, available_by_type)
    actor_melds = _allocate_melds(req.actor_melds, available_by_type)
    actor_draw_id = _allocate_tile_ids([actor_draw], available_by_type)[0]
    opponent_closed_ids = _allocate_tile_ids(opponent_tiles, available_by_type)
    opponent_melds = _allocate_melds(req.opponent_melds, available_by_type)
    dead_wall, indicator_tile_id = _build_dead_wall(available_by_type, dora_indicator)
    live_wall_tail = [tile_id for tt in sorted(available_by_type) for tile_id in available_by_type[tt]]

    actor = engine.players[actor_seat]
    opponent = engine.players[opponent_seat]

    actor.hand.init_deal(actor_closed_ids)
    actor.hand.melds = actor_melds
    actor.hand.add_draw(actor_draw_id)
    opponent.hand.init_deal(opponent_closed_ids)
    opponent.hand.melds = opponent_melds
    if req.actor_points is not None:
        actor.points = req.actor_points
    if req.opponent_points is not None:
        opponent.points = req.opponent_points

    actor.declared_tenpai = False
    opponent.declared_tenpai = False
    actor.tenpai_waits = []
    opponent.tenpai_waits = []
    actor.is_furiten = False
    opponent.is_furiten = False

    engine.phase = Phase.PHASE1_ACTION
    engine.current_turn = actor_seat
    engine.tenpai_declarer = None
    engine.phase2_draw_count = 0
    engine.phase2_guessed_types_by_seat = {0: set(), 1: set()}
    engine.wall.tiles = live_wall_tail
    engine.wall.dead_wall = dead_wall
    engine.wall.dora_indicators = [indicator_tile_id]
    engine.wall.draw_pos = 0
    engine.wall.rinshan_pos = 0
    engine.wall.kan_count = 0
    engine.available_calls.clear()
    engine.last_discard = None
    engine.last_discard_seat = None
    engine._pending_kakan = None
    engine._temp_furiten.clear()
    engine._is_rinshan_draw = False
    engine._total_kan_count = _count_kan_melds(actor_melds, opponent_melds)
    engine.round_result = None
    engine.game_over = False
    engine._ready.clear()

    return {
        "actions": engine.get_state_for_player(actor_seat)["actions"],
    }


def _setup_controlled_phase2(engine, guesser_seat: int, declarer_seat: int, req: Phase2GuessRequest):
    if req.declarer_closed is None or req.guesser_closed is None or req.wall_draw_sequence is None:
        return None

    declarer_tiles = [_normalize_tile_name(tile) for tile in req.declarer_closed]
    declarer_meld_tiles = [_normalize_tile_name(tile) for meld in (req.declarer_melds or []) for tile in meld.tiles]
    guesser_tiles = [_normalize_tile_name(tile) for tile in req.guesser_closed]
    guesser_meld_tiles = [_normalize_tile_name(tile) for meld in (req.guesser_melds or []) for tile in meld.tiles]
    wall_sequence_tiles = [_normalize_tile_name(tile) for tile in req.wall_draw_sequence]
    dora_indicator = _normalize_tile_name(req.dora_indicator) if req.dora_indicator else None
    rinshan_sequence = [_normalize_tile_name(tile) for tile in req.rinshan_sequence] if req.rinshan_sequence else None

    if len(declarer_tiles) + len(declarer_meld_tiles) != 13:
        raise HTTPException(status_code=400, detail="宣听者手牌总张数必须正好13张")
    if len(guesser_tiles) + len(guesser_meld_tiles) != 13:
        raise HTTPException(status_code=400, detail="猜牌方手牌总张数必须正好13张")
    if len(wall_sequence_tiles) < 6:
        raise HTTPException(status_code=400, detail="wall_draw_sequence 至少需要6张")

    combined_tile_names = declarer_tiles + declarer_meld_tiles + guesser_tiles + guesser_meld_tiles + wall_sequence_tiles
    if dora_indicator:
        combined_tile_names.append(dora_indicator)
    if rinshan_sequence:
        combined_tile_names.extend(rinshan_sequence)
    _validate_tile_name_counts(combined_tile_names)

    available_by_type = _build_available_tiles()
    declarer_hand_ids = _allocate_tile_ids(declarer_tiles, available_by_type)
    declarer_melds = _allocate_melds(req.declarer_melds, available_by_type)
    guesser_hand_ids = _allocate_tile_ids(guesser_tiles, available_by_type)
    guesser_melds = _allocate_melds(req.guesser_melds, available_by_type)
    wall_sequence_ids = _allocate_tile_ids(wall_sequence_tiles, available_by_type)
    dead_wall, indicator_tile_id = _build_dead_wall(available_by_type, dora_indicator, rinshan_sequence)
    live_wall_tail = [tile_id for tt in sorted(available_by_type) for tile_id in available_by_type[tt]]

    declarer = engine.players[declarer_seat]
    guesser = engine.players[guesser_seat]

    declarer.hand.init_deal(declarer_hand_ids)
    declarer.hand.melds = declarer_melds
    guesser.hand.init_deal(guesser_hand_ids)
    guesser.hand.melds = guesser_melds
    declarer.declared_tenpai = True
    guesser.declared_tenpai = False
    declarer.is_furiten = False
    guesser.is_furiten = False

    if not is_tenpai(declarer.hand):
        raise HTTPException(status_code=400, detail="declarer_closed 不是有效听牌手")

    declarer.tenpai_waits = waiting_tiles(declarer.hand)
    guesser.tenpai_waits = []

    engine.wall.tiles = wall_sequence_ids + live_wall_tail
    engine.wall.dead_wall = dead_wall
    engine.wall.dora_indicators = [indicator_tile_id]
    engine.wall.draw_pos = 0
    engine.wall.rinshan_pos = 0
    engine.wall.kan_count = 0

    engine.available_calls.clear()
    engine.last_discard = None
    engine.last_discard_seat = None
    engine._pending_kakan = None
    engine._temp_furiten.clear()
    engine._is_rinshan_draw = False
    engine._total_kan_count = _count_kan_melds(declarer_melds, guesser_melds)
    engine.round_result = None
    engine.game_over = False
    engine._ready.clear()

    return {
        "declarer_waits": list(declarer.tenpai_waits),
        "wall_draw_sequence": wall_sequence_ids,
    }


@router.post("/phase2-guess-request")
async def phase2_guess_request(
    req: Phase2GuessRequest,
    authorization: str | None = Header(default=None),
):
    user = get_http_user(authorization)
    room = room_manager.get_player_room(user["id"])
    if room is None:
        raise HTTPException(status_code=404, detail="房间不存在")

    seat = room.user_to_seat.get(user["id"])
    if seat is None:
        raise HTTPException(status_code=404, detail="座位不存在")

    engine = room.engine
    declarer_seat = req.tenpai_declarer if req.tenpai_declarer in (0, 1) else engine.opponent_seat(seat)
    if declarer_seat == seat:
        raise HTTPException(status_code=400, detail="猜牌方不能等于听牌宣言方")
    scenario = _setup_controlled_phase2(engine, seat, declarer_seat, req)

    engine.phase = Phase.PHASE2_GUESS
    engine.tenpai_declarer = declarer_seat
    engine.phase2_draw_count = 0
    engine.current_turn = seat
    engine.phase2_guessed_types_by_seat[seat] = set(req.already_guessed)
    engine.phase2_guessed_types_by_seat[declarer_seat] = set()

    for target_seat in room.player_sockets:
        await engine.notify("game_state", engine.get_state_for_player(target_seat), target_seat=target_seat)

    await engine.notify("phase2_start", {
        "tenpai_declarer": declarer_seat,
        "guesser": seat,
    })
    await engine.notify("phase2_guess_request", {
        "message": req.message,
        "already_guessed": sorted(engine.phase2_guessed_types_by_seat.get(seat, set())),
    }, target_seat=seat)

    return {
        "ok": True,
        "guesser": seat,
        "tenpai_declarer": declarer_seat,
        "already_guessed": sorted(engine.phase2_guessed_types_by_seat.get(seat, set())),
        "declarer_waits": scenario["declarer_waits"] if scenario else None,
    }


@router.post("/phase1-action-state")
async def phase1_action_state(
    req: Phase1ActionStateRequest,
    authorization: str | None = Header(default=None),
):
    user = get_http_user(authorization)
    room = room_manager.get_player_room(user["id"])
    if room is None:
        raise HTTPException(status_code=404, detail="房间不存在")

    seat = room.user_to_seat.get(user["id"])
    if seat is None:
        raise HTTPException(status_code=404, detail="座位不存在")

    scenario = _setup_controlled_phase1_action(room.engine, seat, req)

    for target_seat in room.player_sockets:
        await room.engine.notify("game_state", room.engine.get_state_for_player(target_seat), target_seat=target_seat)

    return {
        "ok": True,
        "actor": seat,
        "actions": scenario["actions"],
    }


@router.post("/game-over-state")
async def game_over_state(
    req: GameOverStateRequest,
    authorization: str | None = Header(default=None),
):
    user = get_http_user(authorization)
    room = room_manager.get_player_room(user["id"])
    if room is None:
        raise HTTPException(status_code=404, detail="房间不存在")

    seat = room.user_to_seat.get(user["id"])
    if seat is None:
        raise HTTPException(status_code=404, detail="座位不存在")

    if req.winner not in (0, 1):
        raise HTTPException(status_code=400, detail="winner 必须是 0 或 1")

    engine = room.engine
    engine.players[0].points = req.seat0_points
    engine.players[1].points = req.seat1_points
    engine.phase = Phase.GAME_OVER
    engine.game_over = True
    engine.current_turn = -1
    engine.tenpai_declarer = None
    engine.phase2_draw_count = 0
    engine.available_calls.clear()
    engine.last_discard = None
    engine.last_discard_seat = None
    engine._pending_kakan = None
    engine._temp_furiten.clear()
    engine._is_rinshan_draw = False
    engine._ready.clear()
    engine.round_result = None
    engine.round_result_payload = dict(req.round_result) if req.round_result is not None else None
    engine.game_over_payload = {
        "winner": req.winner,
        "winner_name": engine.players[req.winner].username,
        "final_points": {
            0: req.seat0_points,
            1: req.seat1_points,
        },
        "honba_count": req.honba_count,
        "riichi_sticks": req.riichi_sticks,
    }

    if engine.round_result_payload is not None:
        await engine.notify("round_result", engine.round_result_payload)
    await engine.notify("game_over", engine.game_over_payload)

    return {
        "ok": True,
        "winner": req.winner,
        "final_points": engine.game_over_payload["final_points"],
    }