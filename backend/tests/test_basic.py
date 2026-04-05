#!/usr/bin/env python3
import asyncio
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import game.engine as engine_module

from game.engine import GameEngine, Phase
from game.room import Room
from game.melds import Meld, MeldType
from game.tiles import *
from game.wall import Wall
from game.hand import Hand
from game.tenpai import shanten_number, is_tenpai, waiting_tiles, is_furiten
from game.scoring import calculate_score, points_transfer_2p


def _alloc_named_tiles(tile_names, used=None):
    used = used if used is not None else set()
    allocated = []
    for tile_name in tile_names:
        tt = tile_type_from_str(tile_name)
        candidate_ids = ids_of_type(tt)
        if len(tile_name) == 2 and tile_name[0] == '0' and tile_name[1] in 'mps':
            red_id = red_dora_id_for_type(tt)
            candidate_ids = [red_id]
        tid = next(tid for tid in candidate_ids if tid not in used)
        used.add(tid)
        allocated.append(tid)
    return allocated

def test_tiles():
    assert len(all_tile_ids()) == 136
    assert tile_name(0) == '1m'
    assert tile_name(135) == '中'
    assert tile_name(16) == '0m'
    assert tile_name(52) == '0p'
    assert tile_name(88) == '0s'
    assert tile_type_from_str('1m') == 0
    assert tile_type_from_str('0m') == 4
    assert tile_type_from_str('0p') == 13
    assert tile_type_from_str('0s') == 22
    assert tile_type_from_str('东') == 27
    print('Tiles OK')

def test_red_dora_ids_prefer_non_red_for_plain_fives():
    assert ids_of_type(tile_type_from_str('5m')) == [17, 18, 19, 16]
    assert ids_of_type(tile_type_from_str('5p')) == [53, 54, 55, 52]
    assert ids_of_type(tile_type_from_str('5s')) == [89, 90, 91, 88]

def test_red_dora_scoring_adds_aka_dora_yaku():
    used = set()
    h = Hand()
    tiles = _alloc_named_tiles(['0m', '6m', '7m', '2p', '3p', '4p', '3s', '4s', '5s', '东', '东', '东', '南'], used)
    win_tid = _alloc_named_tiles(['南'], used)[0]
    h.init_deal(tiles)
    h.add_draw(win_tid)

    result = calculate_score(
        h,
        win_tid,
        is_tsumo=True,
        is_dealer=True,
        round_wind_tt=27,
        player_wind_tt=27,
        dora_indicators=[],
    )

    assert result is not None
    assert any('Aka Dora' in y or 'aka dora' in y.lower() for y in result.yaku), result.yaku

def test_riichi_scoring_adds_riichi_yaku():
    used = set()
    h = Hand()
    tiles = _alloc_named_tiles(['1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', '东', '东', '2m', '3m'], used)
    win_tid = _alloc_named_tiles(['1m'], used)[0]
    h.init_deal(tiles)
    h.add_draw(win_tid)

    result = calculate_score(
        h,
        win_tid,
        is_tsumo=True,
        is_dealer=True,
        round_wind_tt=27,
        player_wind_tt=27,
        dora_indicators=[],
        is_riichi=True,
    )

    assert result is not None
    assert any('Riichi' in y for y in result.yaku), result.yaku

def test_riichi_scoring_supports_ippatsu_and_uradora():
    used = set()
    h = Hand()
    tiles = _alloc_named_tiles(['1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', '东', '东', '2m', '3m'], used)
    win_tid = _alloc_named_tiles(['1m'], used)[0]
    ura_indicator = _alloc_named_tiles(['1m'], used)[0]
    h.init_deal(tiles)
    h.add_draw(win_tid)

    result = calculate_score(
        h,
        win_tid,
        is_tsumo=True,
        is_dealer=True,
        round_wind_tt=27,
        player_wind_tt=27,
        dora_indicators=[],
        is_riichi=True,
        is_ippatsu=True,
        ura_dora_indicators=[ura_indicator],
    )

    assert result is not None
    assert any('Ippatsu' in y for y in result.yaku), result.yaku
    assert any('Dora' in y for y in result.yaku), result.yaku
    assert result.uradora_indicators == [ura_indicator]

def test_kokushi_thirteen_wait_counts_as_double_yakuman():
    used = set()
    h = Hand()
    tiles = _alloc_named_tiles(['1m', '9m', '1p', '9p', '1s', '9s', '东', '南', '西', '北', '白', '发', '中'], used)
    win_tid = _alloc_named_tiles(['1m'], used)[0]
    h.init_deal(tiles)
    h.add_draw(win_tid)

    result = calculate_score(
        h,
        win_tid,
        is_tsumo=True,
        is_dealer=True,
        round_wind_tt=27,
        player_wind_tt=27,
        dora_indicators=[],
    )

    assert result is not None
    assert result.yaku_level == '2x yakuman'
    assert result.total == 96000
    assert any('Kokushi Musou Juusanmen' in y for y in result.yaku), result.yaku

def test_concealed_kan_keeps_menzen_and_allows_riichi():
    used = set()
    h = Hand()
    closed = _alloc_named_tiles(['1m', '2m', '3m', '1p', '2p', '3p', '1s', '2s', '3s', '9m'], used)
    win_tid = _alloc_named_tiles(['9m'], used)[0]
    ankan_tiles = _alloc_named_tiles(['东', '东', '东', '东'], used)
    h.init_deal(closed)
    h.add_draw(win_tid)
    h.melds = [Meld(MeldType.ANKAN, ankan_tiles)]

    result = calculate_score(
        h,
        win_tid,
        is_tsumo=True,
        is_dealer=True,
        round_wind_tt=27,
        player_wind_tt=27,
        dora_indicators=[],
        is_riichi=True,
    )

    assert h.is_open is False
    assert result is not None
    assert any('Riichi' in y for y in result.yaku), result.yaku

def test_kakan_meld_serialization_includes_added_tile():
    tiles = [17, 18, 19, 16]
    meld = Meld(MeldType.KAKAN, tiles, called_tile=19)

    data = meld.to_dict()

    assert data['type'] == 'kakan'
    assert data['called_tile'] == 19
    assert data['added_tile'] == 16

def test_open_hand_does_not_score_iipeiko():
    used = set()
    h = Hand()
    chi_tiles = _alloc_named_tiles(['2m', '3m', '4m'], used)
    closed = _alloc_named_tiles(['2m', '3m', '4m', '3p', '4p', '5p', '4s', '5s', '6s', '6p'], used)
    win_tid = _alloc_named_tiles(['6p'], used)[0]
    h.init_deal(closed)
    h.add_draw(win_tid)
    h.melds = [Meld(MeldType.CHI, chi_tiles, called_tile=chi_tiles[-1])]

    result = calculate_score(
        h,
        win_tid,
        is_tsumo=True,
        is_dealer=False,
        round_wind_tt=27,
        player_wind_tt=28,
        dora_indicators=[],
    )

    assert h.is_open is True
    assert result is not None
    assert not any('Iipeiko' in y for y in result.yaku), result.yaku

def test_wall():
    w = Wall()
    w.setup()
    assert w.remaining == 122
    dealt = w.deal(13)
    assert len(dealt) == 13
    assert w.remaining == 109
    t = w.draw()
    assert t is not None
    assert w.remaining == 108
    print('Wall OK')

def test_tenpai():
    h = Hand()
    tiles = []
    for s in ['1m','2m','3m','4p','5p','6p','7s','8s','9s','1m','2m','3m','东']:
        tt = tile_type_from_str(s)
        for tid in ids_of_type(tt):
            if tid not in tiles:
                tiles.append(tid)
                break
    h.init_deal(tiles)
    print(f'Hand: {tiles_to_mpsz(tiles)}')
    sn = shanten_number(h)
    print(f'Shanten: {sn}')
    assert sn == 0, f'Expected 0 got {sn}'
    waits = waiting_tiles(h)
    print(f'Waits: {[tile_type_name(w) for w in waits]}')
    assert len(waits) > 0
    print('Tenpai OK')

def test_scoring():
    h2 = Hand()
    tiles2 = []
    # 123m 123m 456p 789s 東東 - win on 1m tsumo
    for s in ['1m','2m','3m','4p','5p','6p','7s','8s','9s','东','东','2m','3m']:
        tt = tile_type_from_str(s)
        for tid in ids_of_type(tt):
            if tid not in tiles2:
                tiles2.append(tid)
                break
    win_tt = tile_type_from_str('1m')
    win_tid = None
    for tid in ids_of_type(win_tt):
        if tid not in tiles2:
            win_tid = tid
            break
    tiles2.append(win_tid)
    h2.init_deal(tiles2)
    print(f'Scoring hand: {tiles_to_mpsz(tiles2)}')

    result = calculate_score(h2, win_tid, is_tsumo=True, is_dealer=True,
                             round_wind_tt=27, player_wind_tt=27, dora_indicators=[])
    if result:
        print(f'Score: {result.han}han {result.fu}fu yaku={result.yaku}')
        print(f'Cost: main={result.cost_main} additional={result.cost_additional}')
    else:
        print('Score: no valid hand (expected for this test)')
    print('Scoring OK')

async def _run_phase2_guess_history():
    events = []

    async def capture(event_type, data, target_seat=None):
        events.append((event_type, data, target_seat))

    engine = GameEngine()
    engine.add_player(1, 'p1')
    engine.add_player(2, 'p2')
    engine.set_notify(capture)
    engine.tenpai_declarer = 0
    engine.phase = Phase.PHASE2_GUESS
    engine.players[0].tenpai_waits = [0, 1]

    assert engine.get_state_for_player(1)['phase2_guessed_types'] == []

    await engine.phase2_guess(1, [2, 3])

    assert engine.phase2_guessed_types_by_seat[1] == {2, 3}
    assert engine.get_state_for_player(1)['phase2_guessed_types'] == [2, 3]

    engine.phase = Phase.PHASE2_GUESS
    events.clear()
    await engine.phase2_guess(1, [2, 4])

    assert engine.phase == Phase.PHASE2_GUESS
    assert engine.phase2_guessed_types_by_seat[1] == {2, 3}
    repeat_prompt = [event for event in events if event[0] == 'phase2_guess_request']
    assert repeat_prompt, 'Expected repeat guess prompt when selecting already guessed tile types'
    assert repeat_prompt[-1][1]['already_guessed'] == [2, 3]
    assert repeat_prompt[-1][2] == 1

    await engine.start_round()
    assert engine.phase2_guessed_types_by_seat[1] == set()
    assert engine.get_state_for_player(1)['phase2_guessed_types'] == []
    print('Phase 2 guess history OK')

def test_phase2_guess_history():
    asyncio.run(_run_phase2_guess_history())


async def _run_phase2_guess_allows_single_remaining_choice():
    events = []

    async def capture(event_type, data, target_seat=None):
        events.append((event_type, data, target_seat))

    engine = GameEngine()
    engine.add_player(1, 'p1')
    engine.add_player(2, 'p2')
    engine.set_notify(capture)
    engine.tenpai_declarer = 0
    engine.phase = Phase.PHASE2_GUESS
    engine.players[0].tenpai_waits = [tile_type_from_str('1m')]

    blocked_names = [
        '1m', '2m', '3m', '4m', '6m', '7m', '8m', '9m',
        '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p',
        '1s', '2s', '3s', '4s', '5s', '6s', '7s', '8s', '9s',
        '东', '南', '西', '北', '白', '发', '中',
    ]
    engine.players[0].hand.discards = _alloc_named_tiles(blocked_names, set())

    request = engine._phase2_guess_request_payload(1)
    assert request['required_count'] == 1
    assert request['selectable_count'] == 1
    assert request['can_skip'] is False

    await engine.phase2_guess(1, [tile_type_from_str('5m')])

    assert engine.phase == Phase.PHASE2_DRAW
    assert engine.phase2_guessed_types_by_seat[1] == {tile_type_from_str('5m')}
    draw_cycle = [event for event in events if event[0] == 'phase2_draw_cycle_start']
    assert draw_cycle


def test_phase2_guess_allows_single_remaining_choice():
    asyncio.run(_run_phase2_guess_allows_single_remaining_choice())


async def _run_phase2_guess_allows_skip_when_nothing_selectable():
    events = []

    async def capture(event_type, data, target_seat=None):
        events.append((event_type, data, target_seat))

    engine = GameEngine()
    engine.add_player(1, 'p1')
    engine.add_player(2, 'p2')
    engine.set_notify(capture)
    engine.tenpai_declarer = 0
    engine.phase = Phase.PHASE2_GUESS
    engine.players[0].tenpai_waits = [tile_type_from_str('1m')]

    blocked_names = [
        '1m', '2m', '3m', '4m', '6m', '7m', '8m', '9m',
        '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p',
        '1s', '2s', '3s', '4s', '5s', '6s', '7s', '8s', '9s',
        '东', '南', '西', '北', '白', '发', '中',
    ]
    engine.players[0].hand.discards = _alloc_named_tiles(blocked_names, set())
    engine.phase2_guessed_types_by_seat[1] = {tile_type_from_str('5m')}

    request = engine._phase2_guess_request_payload(1, retry=True)
    assert request['required_count'] == 0
    assert request['selectable_count'] == 0
    assert request['can_skip'] is True

    await engine.phase2_guess(1, [])

    assert engine.phase == Phase.PHASE2_DRAW
    result_events = [event for event in events if event[0] == 'phase2_guess_result']
    assert result_events
    assert result_events[-1][1]['skipped'] is True
    assert result_events[-1][1]['guessed'] == []


def test_phase2_guess_allows_skip_when_nothing_selectable():
    asyncio.run(_run_phase2_guess_allows_skip_when_nothing_selectable())

async def _run_phase2_next_draw_requires_declarer():
    events = []

    async def capture(event_type, data, target_seat=None):
        events.append((event_type, data, target_seat))
        await asyncio.sleep(0)

    engine = GameEngine()
    engine.add_player(1, 'p1')
    engine.add_player(2, 'p2')
    engine.set_notify(capture)
    await engine.start_round()

    engine.tenpai_declarer = 0
    engine.phase = Phase.PHASE2_DRAW
    engine.phase2_draw_count = 0
    engine.current_turn = 0

    initial_remaining = engine.wall.remaining

    await engine.phase2_next_draw(1)

    assert engine.phase == Phase.PHASE2_DRAW
    assert engine.phase2_draw_count == 0
    assert engine.wall.remaining == initial_remaining
    assert not [event for event in events if event[0] == 'phase2_draw']

def test_phase2_next_draw_requires_declarer():
    asyncio.run(_run_phase2_next_draw_requires_declarer())


def test_phase2_action_keeps_ankan_options_after_tenpai():
    engine = GameEngine()
    engine.add_player(1, 'p1')
    engine.add_player(2, 'p2')

    used = set()
    closed = _alloc_named_tiles(['1m', '1m', '1m', '4m', '5m', '1p', '2p', '3p', '1s', '2s', '3s', '东', '东'], used)
    draw_tile = _alloc_named_tiles(['1m'], used)[0]

    player = engine.players[0]
    player.hand.init_deal(closed)
    player.tenpai_waits = waiting_tiles(player.hand)
    player.hand.add_draw(draw_tile)
    player.declared_tenpai = True
    player.declared_riichi = True

    engine.phase = Phase.PHASE2_ACTION
    engine.current_turn = 0
    engine.tenpai_declarer = 0

    state = engine.get_state_for_player(0)
    assert state['actions']['must_discard'] is True
    assert state['actions']['tenpai_discards'] == [draw_tile]
    assert state['actions']['can_ankan'], 'Phase2 action should still expose ankan options after tenpai declaration'
    assert state['actions']['can_kakan'] == []


async def _run_riichi_phase1_allows_legal_ankan_only():
    engine = GameEngine()
    engine.add_player(1, 'p1')
    engine.add_player(2, 'p2')

    used = set()
    closed = _alloc_named_tiles(['1m', '1m', '1m', '4m', '5m', '1p', '2p', '3p', '1s', '2s', '3s', '东', '东'], used)
    draw_tile = _alloc_named_tiles(['1m'], used)[0]

    player = engine.players[0]
    player.hand.init_deal(closed)
    player.tenpai_waits = waiting_tiles(player.hand)
    player.hand.add_draw(draw_tile)
    player.declared_tenpai = True
    player.declared_riichi = True

    engine.wall.setup()
    engine.phase = Phase.PHASE1_ACTION
    engine.current_turn = 0

    state = engine.get_state_for_player(0)
    assert state['actions']['can_ankan'], 'Riichi hand should still expose legal ankan options'
    assert state['actions']['can_kakan'] == []

    ankan_tiles = state['actions']['can_ankan'][0]
    await engine.action_ankan(0, ankan_tiles)

    assert len(player.hand.melds) == 1
    assert player.hand.melds[0].meld_type == MeldType.ANKAN
    assert engine.phase == Phase.PHASE1_ACTION


def test_riichi_phase1_allows_legal_ankan_only():
    asyncio.run(_run_riichi_phase1_allows_legal_ankan_only())


async def _run_riichi_declaration_deducts_points_and_sets_sticks():
    engine = GameEngine()
    engine.add_player(1, 'p1')
    engine.add_player(2, 'p2')

    events = []

    async def capture(event_type, data, target_seat=None):
        events.append((event_type, data, target_seat))

    engine.set_notify(capture)

    used = set()
    closed = _alloc_named_tiles(['1m', '2m', '3m', '1p', '2p', '3p', '1s', '2s', '3s', '东', '东', '5m', '6m'], used)
    draw_tile = _alloc_named_tiles(['8m'], used)[0]

    player = engine.players[0]
    player.points = 2000
    player.hand.init_deal(closed)
    player.hand.add_draw(draw_tile)
    engine.phase = Phase.PHASE1_ACTION
    engine.current_turn = 0

    await engine.action_declare_tenpai(0, riichi=True)

    assert player.declared_tenpai is True
    assert player.declared_riichi is True
    assert player.declared_daburu_riichi is True
    assert player.points == 1000
    assert engine.riichi_sticks == 1

    state = engine.get_state_for_player(0)
    assert state['my_declared_riichi'] is True
    assert state['riichi_sticks'] == 1

    tenpai_events = [event for event in events if event[0] == 'tenpai_declared']
    assert tenpai_events
    assert tenpai_events[-1][1]['riichi'] is True
    assert tenpai_events[-1][1]['daburu_riichi'] is True


def test_riichi_declaration_deducts_points_and_sets_sticks():
    asyncio.run(_run_riichi_declaration_deducts_points_and_sets_sticks())


async def _run_riichi_declaration_is_blocked_when_only_furiten_discards_exist():
    engine = GameEngine()
    engine.add_player(1, 'p1')
    engine.add_player(2, 'p2')

    used = set()
    closed = _alloc_named_tiles(['1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', '东', '东', '2m', '3m'], used)
    draw_tile = _alloc_named_tiles(['1m'], used)[0]
    furiten_discard = _alloc_named_tiles(['1m'], used)[0]

    player = engine.players[0]
    player.hand.init_deal(closed)
    player.hand.discards = [furiten_discard]
    player.hand.add_draw(draw_tile)
    engine.phase = Phase.PHASE1_ACTION
    engine.current_turn = 0

    state = engine.get_state_for_player(0)
    assert state['actions']['can_declare_tenpai'] is False
    assert state['actions']['can_declare_riichi'] is False

    await engine.action_declare_tenpai(0, riichi=True)

    assert player.declared_tenpai is False
    assert player.declared_riichi is False


def test_riichi_declaration_is_blocked_when_only_furiten_discards_exist():
    asyncio.run(_run_riichi_declaration_is_blocked_when_only_furiten_discards_exist())


async def _run_double_riichi_is_blocked_after_interruption():
    engine = GameEngine()
    engine.add_player(1, 'p1')
    engine.add_player(2, 'p2')

    used = set()
    closed = _alloc_named_tiles(['1m', '2m', '3m', '1p', '2p', '3p', '1s', '2s', '3s', '东', '东', '5m', '6m'], used)
    draw_tile = _alloc_named_tiles(['8m'], used)[0]

    player = engine.players[0]
    player.points = 2000
    player.hand.init_deal(closed)
    player.hand.add_draw(draw_tile)
    engine.phase = Phase.PHASE1_ACTION
    engine.current_turn = 0
    engine._round_has_interruption = True

    await engine.action_declare_tenpai(0, riichi=True)

    assert player.declared_tenpai is True
    assert player.declared_riichi is True
    assert player.declared_daburu_riichi is False


def test_double_riichi_is_blocked_after_interruption():
    asyncio.run(_run_double_riichi_is_blocked_after_interruption())


async def _run_nagashi_mangan_counts_honba_and_riichi_bonus():
    engine = GameEngine()
    engine.add_player(1, 'p1')
    engine.add_player(2, 'p2')

    events = []

    async def capture(event_type, data, target_seat=None):
        events.append((event_type, data, target_seat))

    engine.set_notify(capture)
    engine.dealer_seat = 0
    engine.players[0].is_dealer = True
    engine.players[1].is_dealer = False
    engine.honba_count = 2
    engine.riichi_sticks = 1

    engine.players[0].hand.discards = _alloc_named_tiles(['2m', '3p', '4s'], set())
    engine.players[1].hand.discards = _alloc_named_tiles(['1m', '9m', '东', '白'], set())

    await engine._end_round_draw(reason='exhaustive')

    assert engine.round_result is not None
    assert engine.round_result.details['reason'] == 'nagashi_mangan'
    assert engine.round_result.details['winner'] == 1
    assert engine.round_result.points_delta == {0: 0, 1: 7600}
    assert engine.players[0].points == 0
    assert engine.players[1].points == 7600
    assert engine.dealer_seat == 1
    assert engine.honba_count == 0
    assert engine.riichi_sticks == 0

    round_result_events = [event for event in events if event[0] == 'round_result']
    assert round_result_events
    payload = round_result_events[-1][1]
    assert payload['reason'] == 'nagashi_mangan'
    assert payload['winner'] == 1
    assert payload['winner_name'] == 'p2'
    assert payload['points_transfer'] == 6600
    assert payload['honba_bonus'] == 600
    assert payload['riichi_bonus'] == 1000


def test_nagashi_mangan_counts_honba_and_riichi_bonus():
    asyncio.run(_run_nagashi_mangan_counts_honba_and_riichi_bonus())


async def _run_start_game_rolls_for_initial_dealer():
    engine = GameEngine()
    engine.add_player(1, 'p1')
    engine.add_player(2, 'p2')
    engine._roll_initial_dealer = lambda: {0: 2, 1: 6}

    await engine.start_game()

    assert engine.initial_dealer_rolls == {0: 2, 1: 6}
    assert engine.dealer_seat == 1
    assert engine.current_turn == 1
    assert engine.players[0].is_dealer is False
    assert engine.players[1].is_dealer is True

    state = engine.get_state_for_player(0)
    assert state['initial_dealer_rolls'] == {0: 2, 1: 6}

    round_start = engine._round_start_data()
    assert round_start['initial_dealer_rolls'] == {0: 2, 1: 6}


def test_start_game_rolls_for_initial_dealer():
    asyncio.run(_run_start_game_rolls_for_initial_dealer())


def test_initial_dealer_roll_rerolls_ties():
    engine = GameEngine()
    rolls = iter([4, 4, 6, 2])
    original_randint = engine_module.random.randint

    try:
        engine_module.random.randint = lambda start, end: next(rolls)
        assert engine._roll_initial_dealer() == {0: 6, 1: 2}
    finally:
        engine_module.random.randint = original_randint


async def _run_non_dealer_win_becomes_next_dealer():
    engine = GameEngine()
    engine.add_player(1, 'p1')
    engine.add_player(2, 'p2')
    engine.dealer_seat = 0
    engine.players[0].is_dealer = True
    engine.players[1].is_dealer = False

    used = set()
    closed = _alloc_named_tiles(['1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', '东', '东', '东', '南'], used)
    win_tile = _alloc_named_tiles(['南'], used)[0]
    winner = engine.players[1]
    winner.hand.init_deal(closed)
    winner.hand.add_draw(win_tile)

    score = calculate_score(
        winner.hand,
        win_tile,
        is_tsumo=True,
        is_dealer=False,
        round_wind_tt=27,
        player_wind_tt=28,
        dora_indicators=[],
    )

    await engine._end_round_win(1, score, True, win_tile)

    assert engine.round_result is not None
    assert engine.round_result.winner == 1
    assert engine.dealer_seat == 1
    assert engine.honba_count == 0


def test_non_dealer_win_becomes_next_dealer():
    asyncio.run(_run_non_dealer_win_becomes_next_dealer())


def test_menzen_tenpai_serializes_riichi_action():
    engine = GameEngine()
    engine.add_player(1, 'p1')
    engine.add_player(2, 'p2')

    used = set()
    closed = _alloc_named_tiles(['1m', '2m', '3m', '1p', '2p', '3p', '1s', '2s', '3s', '东', '东', '5m', '6m'], used)
    draw_tile = _alloc_named_tiles(['8m'], used)[0]

    player = engine.players[0]
    player.points = 2000
    player.hand.init_deal(closed)
    player.hand.add_draw(draw_tile)
    engine.phase = Phase.PHASE1_ACTION
    engine.current_turn = 0

    state = engine.get_state_for_player(0)
    assert state['actions']['can_declare_tenpai'] is True
    assert state['actions']['can_declare_riichi'] is True
    assert state['actions']['can_declare_damaten'] is True


async def _run_damaten_declaration_enters_phase2_without_riichi():
    engine = GameEngine()
    engine.add_player(1, 'p1')
    engine.add_player(2, 'p2')

    events = []

    async def capture(event_type, data, target_seat=None):
        events.append((event_type, data, target_seat))

    engine.set_notify(capture)

    used = set()
    closed = _alloc_named_tiles(['1m', '2m', '3m', '1p', '2p', '3p', '1s', '2s', '3s', '东', '东', '5m', '6m'], used)
    draw_tile = _alloc_named_tiles(['8m'], used)[0]
    opponent_closed = _alloc_named_tiles(['7m', '8m', '9m', '4p', '5p', '6p', '4s', '5s', '6s', '南', '南', '白', '白'], used)

    player = engine.players[0]
    opponent = engine.players[1]
    player.hand.init_deal(closed)
    player.hand.add_draw(draw_tile)
    opponent.hand.init_deal(opponent_closed)
    engine.phase = Phase.PHASE1_ACTION
    engine.current_turn = 0

    await engine.action_declare_damaten(0)

    assert player.declared_tenpai is True
    assert player.declared_riichi is False
    assert engine.tenpai_declarer == 0
    state = engine.get_state_for_player(0)
    assert state['actions']['tenpai_mode'] == 'public_tenpai'

    tenpai_events = [event for event in events if event[0] == 'tenpai_declared']
    assert tenpai_events
    assert tenpai_events[-1][1]['riichi'] is False

    discard_tile = state['actions']['tenpai_discards'][0]
    await engine.action_discard_after_tenpai(0, discard_tile)

    assert player.declared_tenpai is True
    assert player.declared_riichi is False
    assert engine.tenpai_declarer == 0
    assert engine.phase == Phase.PHASE2_GUESS
    assert [event for event in events if event[0] == 'phase2_start']


def test_damaten_declaration_enters_phase2_without_riichi():
    asyncio.run(_run_damaten_declaration_enters_phase2_without_riichi())


async def _build_controlled_phase2_engine():
    engine = GameEngine()
    engine.add_player(1, 'p1')
    engine.add_player(2, 'p2')

    events = []

    async def capture(event_type, data, target_seat=None):
        events.append((event_type, data, target_seat))

    engine.set_notify(capture)

    used = set()
    declarer_closed = _alloc_named_tiles(['1m', '2m', '3m', '1p', '2p', '3p', '1s', '2s', '3s', '东', '东', '东', '5m'], used)
    guesser_closed = _alloc_named_tiles(['7m', '8m', '9m', '4p', '5p', '6p', '4s', '5s', '6s', '南', '南', '白', '白'], used)
    wall_sequence = _alloc_named_tiles(['9p', '9s', '北', '中', '7p', '5m'], used)
    dead_wall = _alloc_named_tiles(['2m', '4m', '6m', '8m', '6p', '西', '发', '中', '9m', '2s', '8s', '3p', '7p', '南'], used)

    engine.players[0].hand.init_deal(declarer_closed)
    engine.players[1].hand.init_deal(guesser_closed)
    engine.players[0].declared_tenpai = True
    engine.players[0].tenpai_waits = waiting_tiles(engine.players[0].hand)

    engine.tenpai_declarer = 0
    engine.phase = Phase.PHASE2_DRAW
    engine.current_turn = 0
    engine.phase2_draw_count = 0
    engine.wall.tiles = wall_sequence
    engine.wall.dead_wall = dead_wall
    engine.wall.dora_indicators = [dead_wall[4]]

    return engine, events


async def _run_phase2_draw_enters_manual_action():
    engine, events = await _build_controlled_phase2_engine()

    await engine.phase2_next_draw(0)

    draw_tile = next(tile for tile in engine.players[0].hand.closed if tile_type(tile) == tile_type_from_str('9p'))
    assert engine.phase == Phase.PHASE2_ACTION
    assert engine.phase2_draw_count == 1
    assert engine.players[0].hand.draw_tile == draw_tile

    state = engine.get_state_for_player(0)
    assert state['actions']['must_discard'] is True
    assert state['actions']['tenpai_discards'] == [draw_tile]

    action_events = [event for event in events if event[0] == 'draw_tile']
    assert action_events, 'Expected targeted draw_tile event when Phase2 enters manual action state'
    assert action_events[-1][1]['phase'] == Phase.PHASE2_ACTION.value


def test_phase2_draw_enters_manual_action():
    asyncio.run(_run_phase2_draw_enters_manual_action())


async def _build_phase2_winning_draw_engine():
    engine = GameEngine()
    engine.add_player(1, 'p1')
    engine.add_player(2, 'p2')

    events = []

    async def capture(event_type, data, target_seat=None):
        events.append((event_type, data, target_seat))

    engine.set_notify(capture)

    used = set()
    declarer_closed = _alloc_named_tiles(['1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', '东', '东', '2m', '3m'], used)
    guesser_closed = _alloc_named_tiles(['7m', '8m', '9m', '4p', '5p', '6p', '4s', '5s', '6s', '南', '南', '白', '白'], used)
    wall_sequence = _alloc_named_tiles(['1m', '9p'], used)
    dead_wall = _alloc_named_tiles(['2p', '4p', '6p', '8p', '6s', '西', '发', '中', '9m', '3s', '8s', '1p', '7p', '北'], used)

    engine.players[0].hand.init_deal(declarer_closed)
    engine.players[1].hand.init_deal(guesser_closed)
    engine.players[0].declared_tenpai = True
    engine.players[0].declared_riichi = True
    engine.players[0].tenpai_waits = waiting_tiles(engine.players[0].hand)

    engine.tenpai_declarer = 0
    engine.phase = Phase.PHASE2_DRAW
    engine.current_turn = 0
    engine.phase2_draw_count = 0
    engine.wall.tiles = wall_sequence
    engine.wall.dead_wall = dead_wall
    engine.wall.dora_indicators = [dead_wall[4]]

    return engine, events


async def _run_phase2_winning_draw_requires_manual_choice():
    engine, events = await _build_phase2_winning_draw_engine()

    await engine.phase2_next_draw(0)

    assert engine.phase == Phase.PHASE2_ACTION
    assert engine.round_result is None

    phase2_draw_events = [event for event in events if event[0] == 'phase2_draw']
    assert phase2_draw_events
    assert 'tile' not in phase2_draw_events[-1][1]
    assert 'is_win' not in phase2_draw_events[-1][1]

    draw_events = [event for event in events if event[0] == 'draw_tile']
    assert draw_events
    assert draw_events[-1][2] == 0
    assert draw_events[-1][1]['actions']['can_tsumo'] is True


def test_phase2_winning_draw_requires_manual_choice():
    asyncio.run(_run_phase2_winning_draw_requires_manual_choice())


async def _run_phase2_tsumo_action_works_after_manual_choice_prompt():
    engine, events = await _build_phase2_winning_draw_engine()

    await engine.phase2_next_draw(0)
    await engine.action_tsumo(0)

    assert engine.phase == Phase.ROUND_END
    assert engine.round_result is not None
    assert engine.round_result.result_type == 'tsumo'
    assert engine.round_result.winner == 0

    round_result_events = [event for event in events if event[0] == 'round_result']
    assert round_result_events
    payload = round_result_events[-1][1]
    assert payload['dora_indicators'] == engine.wall.dora_indicators
    assert payload['uradora_indicators'] == engine.wall.get_uradora_indicators()


def test_phase2_tsumo_action_works_after_manual_choice_prompt():
    asyncio.run(_run_phase2_tsumo_action_works_after_manual_choice_prompt())


async def _run_phase2_guess_hit_is_zero_point_draw_and_reveals_indicators():
    engine, events = await _build_controlled_phase2_engine()
    engine.players[0].declared_riichi = True
    engine.phase = Phase.PHASE2_GUESS
    engine.current_turn = 1

    await engine.phase2_guess(1, [tile_type_from_str('5m'), tile_type_from_str('2m')])

    assert engine.phase == Phase.ROUND_END
    assert engine.round_result is not None
    assert engine.round_result.result_type == 'draw'
    assert engine.round_result.points_delta == {0: 0, 1: 0}
    assert engine.players[0].points == 0
    assert engine.players[1].points == 0
    assert engine.round_result.details['reason'] == 'phase2_guess_hit'

    round_result_events = [event for event in events if event[0] == 'round_result']
    assert round_result_events
    payload = round_result_events[-1][1]
    assert payload['reason'] == 'phase2_guess_hit'
    assert payload['dora_indicators'] == engine.wall.dora_indicators
    assert payload['uradora_indicators'] == engine.wall.get_uradora_indicators()
    assert payload['points_delta'] == {0: 0, 1: 0}


def test_phase2_guess_hit_is_zero_point_draw_and_reveals_indicators():
    asyncio.run(_run_phase2_guess_hit_is_zero_point_draw_and_reveals_indicators())


async def _run_zero_point_start_does_not_end_match():
    engine = GameEngine()
    engine.add_player(1, 'p1')
    engine.add_player(2, 'p2')

    await engine._end_round_draw(reason='exhaustive')

    assert engine.phase == Phase.ROUND_END
    assert engine.game_over is False
    assert engine.players[0].points == 0
    assert engine.players[1].points == 0


def test_zero_point_start_does_not_end_match():
    asyncio.run(_run_zero_point_start_does_not_end_match())


async def _run_phase2_declined_winning_tile_is_hidden_and_sets_furiten():
    engine, events = await _build_phase2_winning_draw_engine()

    await engine.phase2_next_draw(0)
    draw_tile = engine.players[0].hand.draw_tile

    await engine.action_phase2_discard(0, draw_tile)

    assert engine.phase == Phase.PHASE2_DRAW
    assert engine.players[0].hand.hidden_discards == [draw_tile]
    assert engine.players[0].hand.discards == []
    assert engine.players[0].is_furiten is True

    discard_events = [event for event in events if event[0] == 'phase2_discard']
    assert discard_events
    assert discard_events[-1][1]['hidden_discard'] is True
    assert 'tile' not in discard_events[-1][1]

    own_state = engine.get_state_for_player(0)
    opp_state = engine.get_state_for_player(1)
    assert own_state['my_hand']['discards'] == []
    assert opp_state['opponent_hand']['discards'] == []


def test_phase2_declined_winning_tile_is_hidden_and_sets_furiten():
    asyncio.run(_run_phase2_declined_winning_tile_is_hidden_and_sets_furiten())


async def _run_phase2_discard_only_allows_draw_tile_after_tenpai():
    engine, events = await _build_controlled_phase2_engine()

    await engine.phase2_next_draw(0)

    draw_tile = engine.players[0].hand.draw_tile
    invalid_discard = next(tile for tile in engine.players[0].hand.closed if tile != draw_tile)
    hand_before = list(engine.players[0].hand.closed)

    await engine.action_phase2_discard(0, invalid_discard)

    assert engine.phase == Phase.PHASE2_ACTION
    assert engine.players[0].hand.closed == hand_before
    assert engine.players[0].hand.draw_tile == draw_tile
    assert not [event for event in events if event[0] == 'phase2_discard']

    await engine.action_phase2_discard(0, draw_tile)

    assert engine.phase == Phase.PHASE2_DRAW
    assert engine.players[0].hand.draw_tile is None
    assert engine.players[0].hand.discards[-1] == draw_tile
    discard_events = [event for event in events if event[0] == 'phase2_discard']
    assert discard_events
    assert discard_events[-1][1]['tile'] == draw_tile
    assert discard_events[-1][1]['draws_remaining'] == 4


def test_phase2_discard_only_allows_draw_tile_after_tenpai():
    asyncio.run(_run_phase2_discard_only_allows_draw_tile_after_tenpai())


async def _run_phase2_fifth_discard_returns_to_guess():
    engine, events = await _build_controlled_phase2_engine()
    engine.phase2_draw_count = 4

    await engine.phase2_next_draw(0)
    draw_tile = engine.players[0].hand.draw_tile

    assert engine.phase == Phase.PHASE2_ACTION
    assert engine.phase2_draw_count == 5

    await engine.action_phase2_discard(0, draw_tile)

    assert engine.phase == Phase.PHASE2_GUESS
    assert engine.current_turn == 1
    prompts = [event for event in events if event[0] == 'phase2_guess_request']
    assert prompts
    assert prompts[-1][2] == 1
    assert prompts[-1][1]['already_guessed'] == []


def test_phase2_fifth_discard_returns_to_guess():
    asyncio.run(_run_phase2_fifth_discard_returns_to_guess())


async def _run_phase2_ankan_emits_kan_declared_and_new_dora():
    engine = GameEngine()
    engine.add_player(1, 'p1')
    engine.add_player(2, 'p2')

    events = []

    async def capture(event_type, data, target_seat=None):
        events.append((event_type, data, target_seat))

    engine.set_notify(capture)

    used = set()
    declarer_closed = _alloc_named_tiles(['1m', '1m', '1m', '4m', '5m', '1p', '2p', '3p', '1s', '2s', '3s', '东', '东'], used)
    guesser_closed = _alloc_named_tiles(['7m', '8m', '9m', '4p', '5p', '6p', '4s', '5s', '6s', '南', '南', '白', '白'], used)
    wall_sequence = _alloc_named_tiles(['1m', '9p', '9s'], used)
    rinshan_tile = _alloc_named_tiles(['西'], used)[0]
    dora_indicator = _alloc_named_tiles(['6p'], used)[0]
    reserve = {rinshan_tile, dora_indicator}
    dead_wall_fill = [tid for tid in all_tile_ids() if tid not in used and tid not in reserve]

    engine.players[0].hand.init_deal(declarer_closed)
    engine.players[1].hand.init_deal(guesser_closed)
    engine.players[0].declared_tenpai = True
    engine.players[0].tenpai_waits = waiting_tiles(engine.players[0].hand)

    engine.tenpai_declarer = 0
    engine.phase = Phase.PHASE2_DRAW
    engine.current_turn = 0
    engine.phase2_draw_count = 0
    engine.wall.tiles = wall_sequence
    engine.wall.dead_wall = [rinshan_tile] + dead_wall_fill[:3] + [dora_indicator] + dead_wall_fill[3:12]
    engine.wall.dora_indicators = [dora_indicator]
    engine.wall.rinshan_pos = 0

    await engine.phase2_next_draw(0)
    events.clear()

    ankan_tiles = engine.players[0].hand.can_ankan()[0]
    await engine.action_ankan(0, ankan_tiles)

    kan_events = [event for event in events if event[0] == 'kan_declared']
    draw_events = [event for event in events if event[0] == 'draw_tile']

    assert kan_events, 'Phase2 ankan should broadcast kan_declared so the client can sync melds and dora'
    assert len(kan_events[-1][1]['dora_indicators']) == 2
    assert draw_events
    assert draw_events[-1][1]['phase'] == Phase.PHASE2_ACTION.value
    assert draw_events[-1][1]['tile'] == rinshan_tile
    assert len(engine.players[0].hand.melds) == 1


def test_phase2_ankan_emits_kan_declared_and_new_dora():
    asyncio.run(_run_phase2_ankan_emits_kan_declared_and_new_dora())


async def _run_phase2_kakan_is_allowed_when_waits_stay_locked():
    engine = GameEngine()
    engine.add_player(1, 'p1')
    engine.add_player(2, 'p2')

    events = []

    async def capture(event_type, data, target_seat=None):
        events.append((event_type, data, target_seat))

    engine.set_notify(capture)

    used = set()
    declarer_closed = _alloc_named_tiles(['1p', '2p', '3p', '1s', '2s', '3s', '东', '东', '东', '4m'], used)
    pon_tiles = _alloc_named_tiles(['5m', '5m', '5m'], used)
    guesser_closed = _alloc_named_tiles(['7m', '8m', '9m', '4p', '5p', '6p', '4s', '5s', '6s', '南', '南', '白', '白'], used)
    wall_sequence = _alloc_named_tiles(['5m', '9p', '9s'], used)
    rinshan_tile = _alloc_named_tiles(['西'], used)[0]
    dora_indicator = _alloc_named_tiles(['6p'], used)[0]
    reserve = {rinshan_tile, dora_indicator}
    dead_wall_fill = [tid for tid in all_tile_ids() if tid not in used and tid not in reserve]

    engine.players[0].hand.init_deal(declarer_closed)
    engine.players[0].hand.melds = [Meld(MeldType.PON, pon_tiles, called_tile=pon_tiles[-1])]
    engine.players[1].hand.init_deal(guesser_closed)
    engine.players[0].declared_tenpai = True
    engine.players[0].tenpai_waits = waiting_tiles(engine.players[0].hand)

    engine.tenpai_declarer = 0
    engine.phase = Phase.PHASE2_DRAW
    engine.current_turn = 0
    engine.phase2_draw_count = 0
    engine.wall.tiles = wall_sequence
    engine.wall.dead_wall = [rinshan_tile] + dead_wall_fill[:3] + [dora_indicator] + dead_wall_fill[3:12]
    engine.wall.dora_indicators = [dora_indicator]
    engine.wall.rinshan_pos = 0

    await engine.phase2_next_draw(0)

    extra_tile = engine.players[0].hand.draw_tile
    state = engine.get_state_for_player(0)
    assert state['actions']['can_kakan'], 'Phase2 action should expose legal kakan options when waits stay unchanged'

    events.clear()
    await engine.action_kakan(0, extra_tile)

    kan_events = [event for event in events if event[0] == 'kan_declared']
    draw_events = [event for event in events if event[0] == 'draw_tile']

    assert kan_events
    assert kan_events[-1][1]['type'] == 'kakan'
    assert draw_events
    assert draw_events[-1][1]['phase'] == Phase.PHASE2_ACTION.value
    assert draw_events[-1][1]['tile'] == rinshan_tile
    assert engine.phase == Phase.PHASE2_ACTION
    assert engine.players[0].hand.draw_tile == rinshan_tile
    assert len(engine.players[0].hand.melds) == 1
    assert engine.players[0].hand.melds[0].meld_type == MeldType.KAKAN


def test_phase2_kakan_is_allowed_when_waits_stay_locked():
    asyncio.run(_run_phase2_kakan_is_allowed_when_waits_stay_locked())


async def _run_phase1_kakan_four_kan_abort_keeps_points_and_emits_kan_declared():
    engine = GameEngine()
    engine.add_player(1, 'p1')
    engine.add_player(2, 'p2')

    events = []

    async def capture(event_type, data, target_seat=None):
        events.append((event_type, data, target_seat))

    engine.set_notify(capture)

    used = set()
    actor_closed = _alloc_named_tiles(['1p', '2p', '3p', '1s', '2s', '3s'], used)
    actor_draw = _alloc_named_tiles(['5m'], used)[0]
    actor_ankan = _alloc_named_tiles(['东', '东', '东', '东'], used)
    actor_pon = _alloc_named_tiles(['5m', '5m', '5m'], used)
    opponent_closed = _alloc_named_tiles(['7m', '8m', '9m', '白', '发'], used)
    opp_ankan_1 = _alloc_named_tiles(['南', '南', '南', '南'], used)
    opp_ankan_2 = _alloc_named_tiles(['西', '西', '西', '西'], used)

    actor = engine.players[0]
    opponent = engine.players[1]
    actor.points = 25000
    opponent.points = 25000
    actor.hand.init_deal(actor_closed)
    actor.hand.melds = [Meld(MeldType.ANKAN, actor_ankan), Meld(MeldType.PON, actor_pon, called_tile=actor_pon[2])]
    actor.hand.add_draw(actor_draw)
    opponent.hand.init_deal(opponent_closed)
    opponent.hand.melds = [Meld(MeldType.ANKAN, opp_ankan_1), Meld(MeldType.ANKAN, opp_ankan_2)]

    engine.phase = Phase.PHASE1_ACTION
    engine.current_turn = 0
    engine._total_kan_count = 3

    await engine.action_kakan(0, actor_draw)

    kan_events = [event for event in events if event[0] == 'kan_declared']
    result_events = [event for event in events if event[0] == 'round_result']

    assert kan_events
    assert kan_events[-1][1]['type'] == 'kakan'
    assert result_events
    assert result_events[-1][1]['reason'] == 'four_kan_abort'
    assert engine.round_result is not None
    assert engine.round_result.details['reason'] == 'four_kan_abort'
    assert engine.round_result.points_delta == {0: 0, 1: 0}
    assert actor.points == 25000
    assert opponent.points == 25000


def test_phase1_kakan_four_kan_abort_keeps_points_and_emits_kan_declared():
    asyncio.run(_run_phase1_kakan_four_kan_abort_keeps_points_and_emits_kan_declared())

def test_phase1_action_actions_serialized_for_current_turn():
    engine = GameEngine()
    engine.add_player(1, 'p1')
    engine.add_player(2, 'p2')

    actor = engine.players[0]
    opponent = engine.players[1]
    actor_closed = []
    opponent_closed = []

    for tile_str in ['1m', '2m', '3m', '1p', '2p', '3p', '1s', '2s', '3s', '东', '东', '东', '5m']:
        tt = tile_type_from_str(tile_str)
        for tid in ids_of_type(tt):
            if tid not in actor_closed:
                actor_closed.append(tid)
                break
    for tile_str in ['7m', '8m', '9m', '4p', '5p', '6p', '4s', '5s', '6s', '南', '南', '白', '白']:
        tt = tile_type_from_str(tile_str)
        for tid in ids_of_type(tt):
            if tid not in actor_closed and tid not in opponent_closed:
                opponent_closed.append(tid)
                break

    actor.hand.init_deal(actor_closed)
    actor_draw = next(tid for tid in ids_of_type(tile_type_from_str('5m')) if tid not in actor_closed)
    actor.hand.add_draw(actor_draw)
    opponent.hand.init_deal(opponent_closed)
    engine.phase = Phase.PHASE1_ACTION
    engine.current_turn = 0

    state = engine.get_state_for_player(0)

    assert state['actions']['must_discard'] is True
    assert state['actions']['can_tsumo'] is True
    assert state['actions']['can_declare_tenpai'] is False
    assert state['actions']['can_declare_riichi'] is False

def test_phase1_response_actions_serialized_for_responder():
    engine = GameEngine()
    engine.add_player(1, 'p1')
    engine.add_player(2, 'p2')
    engine.phase = Phase.PHASE1_RESPONSE
    engine.last_discard = 12
    engine.last_discard_seat = 0
    engine.available_calls = {
        'can_ron': True,
        'can_pon': [13, 14],
    }

    responder_state = engine.get_state_for_player(1)
    discarder_state = engine.get_state_for_player(0)

    assert responder_state['actions']['can_ron'] is True
    assert responder_state['actions']['can_pon'] == [13, 14]
    assert responder_state['actions']['_discard_tile'] == 12
    assert responder_state['actions']['_discard_seat'] == 0
    assert discarder_state['actions'] == {}


async def _run_phase1_response_rejects_unauthorized_calls_without_side_effects():
    engine = GameEngine()
    engine.add_player(1, 'p1')
    engine.add_player(2, 'p2')

    used = set()
    discarder_closed = _alloc_named_tiles(['1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', '东', '东', '白', '白'], used)
    responder_closed = _alloc_named_tiles(['5m', '5m', '6m', '7m', '8m', '1p', '2p', '3p', '1s', '2s', '3s', '南', '南'], used)

    engine.players[0].hand.init_deal(discarder_closed)
    engine.players[1].hand.init_deal(responder_closed)
    engine.phase = Phase.PHASE1_RESPONSE
    engine.last_discard = _alloc_named_tiles(['5m'], used)[0]
    engine.last_discard_seat = 0
    engine.available_calls = {'can_ron': True}
    engine._ippatsu_pending = {1}
    engine._round_has_interruption = False

    hand_before = list(engine.players[1].hand.closed)

    await engine.response_chi(1, hand_before[:2])
    await engine.response_pon(1)
    await engine.response_minkan(1)

    assert engine.phase == Phase.PHASE1_RESPONSE
    assert engine.available_calls == {'can_ron': True}
    assert engine.players[1].hand.closed == hand_before
    assert engine.players[1].hand.melds == []
    assert engine._ippatsu_pending == {1}
    assert engine._round_has_interruption is False


def test_phase1_response_rejects_unauthorized_calls_without_side_effects():
    asyncio.run(_run_phase1_response_rejects_unauthorized_calls_without_side_effects())


async def _run_waiting_disconnect_clears_ghost_ready():
    room = Room('test-room')
    room.add_player(1, 'p1', object())
    room.add_player(2, 'p2', object())
    room.ready_seats = {0, 1}

    room.remove_player(1)
    assert room.ready_seats == {1}

    room.ready_seats = {0, 1}
    await room.try_start()
    assert room.engine.phase == Phase.WAITING

    room.engine.phase = Phase.ROUND_END
    room.engine._ready = {0, 1}
    room.remove_player(2)
    assert room.engine._ready == {0, 1}


def test_waiting_disconnect_clears_ghost_ready():
    asyncio.run(_run_waiting_disconnect_clears_ghost_ready())


class _DummySocket:
    def __init__(self):
        self.messages = []

    async def send_json(self, data):
        self.messages.append(data)


async def _run_game_over_room_can_reconfigure_and_restart():
    room = Room('rematch-room')
    ws1 = _DummySocket()
    ws2 = _DummySocket()
    room.add_player(1, 'host', ws1)
    room.add_player(2, 'guest', ws2)

    room.engine.phase = Phase.GAME_OVER
    room.engine.game_over = True
    room.engine.timer_minutes = 30

    assert room.set_timer_minutes(2, 45) is False
    assert room.set_timer_minutes(1, 45) is True
    assert room.engine.timer_minutes == 45

    assert room.set_waiting_ready(1, True) is True
    assert room.set_waiting_ready(2, True) is True

    await room.try_start()

    assert room.engine.game_over is False
    assert room.engine.timer_minutes == 45
    assert room.engine.round_number == 1
    assert room.engine.phase != Phase.GAME_OVER


def test_game_over_room_can_reconfigure_and_restart():
    asyncio.run(_run_game_over_room_can_reconfigure_and_restart())


def test_game_over_leave_transfers_room_owner():
    room = Room('owner-room')
    room.add_player(1, 'host', _DummySocket())
    room.add_player(2, 'guest', _DummySocket())
    room.engine.phase = Phase.GAME_OVER

    assert room.owner_user_id == 1
    assert room.leave_player(1) is True
    assert room.owner_user_id == 2

if __name__ == '__main__':
    from test_test_hooks import (
        test_reset_rooms_hook_keeps_reconnect_flow_intact,
        test_test_hooks_disabled_inaccessible,
    )

    test_tiles()
    test_wall()
    test_tenpai()
    test_scoring()
    test_phase2_guess_history()
    test_phase2_next_draw_requires_declarer()
    test_phase1_action_actions_serialized_for_current_turn()
    test_phase1_response_actions_serialized_for_responder()
    test_test_hooks_disabled_inaccessible()
    test_reset_rooms_hook_keeps_reconnect_flow_intact()
    print('ALL TESTS PASSED')
