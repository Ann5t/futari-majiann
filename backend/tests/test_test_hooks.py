#!/usr/bin/env python3
import sys, os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from fastapi.testclient import TestClient

from main import create_app
from game.room import room_manager
from test_hooks import Phase2GuessRequest, Phase1ActionStateRequest, _setup_controlled_phase2, _setup_controlled_phase1_action


def test_test_hooks_disabled_inaccessible():
    with TestClient(create_app(enable_test_hooks=False)) as disabled_client:
        disabled_reset_response = disabled_client.post('/api/test/reset-rooms')
        assert disabled_reset_response.status_code == 404

        disabled_response = disabled_client.post('/api/test/phase2-guess-request', json={
            'already_guessed': [0, 9],
            'tenpai_declarer': 0,
        })
        assert disabled_response.status_code == 404

        disabled_phase1_response = disabled_client.post('/api/test/phase1-action-state', json={
            'actor_closed': ['1m'] * 13,
            'actor_draw': '1m',
            'opponent_closed': ['2m'] * 13,
        })
        assert disabled_phase1_response.status_code == 404

    with TestClient(create_app(enable_test_hooks=True)) as enabled_client:
        enabled_reset_response = enabled_client.post('/api/test/reset-rooms')
        assert enabled_reset_response.status_code == 200

        enabled_response = enabled_client.post('/api/test/phase2-guess-request', json={
            'already_guessed': [0, 9],
            'tenpai_declarer': 0,
        })
        assert enabled_response.status_code == 401

        enabled_phase1_response = enabled_client.post('/api/test/phase1-action-state', json={
            'actor_closed': ['1m'] * 13,
            'actor_draw': '1m',
            'opponent_closed': ['2m'] * 13,
        })
        assert enabled_phase1_response.status_code == 401


def test_reset_rooms_hook_keeps_reconnect_flow_intact():
    with TestClient(create_app(enable_test_hooks=True)) as client:
        reset_response = client.post('/api/test/reset-rooms')
        assert reset_response.status_code == 200
        assert reset_response.json()['ok'] is True

        room = room_manager.create_room()
        first_socket = object()
        reconnected_socket = object()

        seat = room.add_player(1, 'p1', first_socket)
        assert seat == 0
        assert room.user_to_seat[1] == 0
        assert room.player_sockets[0] is first_socket

        room.remove_player(1)
        assert 0 not in room.player_sockets
        assert room.user_to_seat[1] == 0

        reconnect_seat = room.reconnect_player(1, reconnected_socket)
        assert reconnect_seat == 0
        assert room.user_to_seat[1] == 0
        assert room.player_sockets[0] is reconnected_socket
        assert room.engine.players[0] is not None
        assert room.engine.players[0].username == 'p1'

        room_manager.reset()


def test_setup_controlled_phase2_rejects_non_tenpai_hand():
    room = room_manager.create_room()
    room.add_player(1, 'p1', object())
    room.add_player(2, 'p2', object())

    req = Phase2GuessRequest(
        already_guessed=[],
        tenpai_declarer=0,
        declarer_closed=['1m', '3m', '5m', '7m', '9m', '1p', '3p', '5p', '7p', '9p', '东', '南', '白'],
        guesser_closed=['7m', '8m', '9m', '4p', '5p', '6p', '4s', '5s', '6s', '南', '南', '白', '白'],
        wall_draw_sequence=['9p', '9s', '北', '中', '7p', '5m'],
    )

    try:
        _setup_controlled_phase2(room.engine, 1, 0, req)
        assert False, 'Expected invalid declarer hand to be rejected'
    except Exception as exc:
        from fastapi import HTTPException
        assert isinstance(exc, HTTPException)
        assert exc.status_code == 400

    room_manager.reset()


def test_setup_controlled_phase2_populates_hand_and_wall():
    room = room_manager.create_room()
    room.add_player(1, 'p1', object())
    room.add_player(2, 'p2', object())

    req = Phase2GuessRequest(
        already_guessed=[],
        tenpai_declarer=0,
        declarer_closed=['1m', '2m', '3m', '1p', '2p', '3p', '1s', '2s', '3s', '东', '东', '东', '5m'],
        guesser_closed=['7m', '8m', '9m', '4p', '5p', '6p', '4s', '5s', '6s', '南', '南', '白', '白'],
        wall_draw_sequence=['9p', '9s', '北', '中', '7p', '5m'],
        dora_indicator='6p',
    )

    scenario = _setup_controlled_phase2(room.engine, 1, 0, req)

    assert scenario is not None
    assert len(room.engine.players[0].hand.closed) == 13
    assert len(room.engine.players[1].hand.closed) == 13
    assert room.engine.players[0].declared_tenpai is True
    assert scenario['declarer_waits'] == [4]
    assert room.engine.wall.dora_indicators[0] // 4 == 14
    assert room.engine.wall.tiles[0] // 4 == 17
    assert room.engine.wall.tiles[5] // 4 == 4

    room_manager.reset()


def test_setup_controlled_phase2_can_override_rinshan_sequence():
    room = room_manager.create_room()
    room.add_player(1, 'p1', object())
    room.add_player(2, 'p2', object())

    req = Phase2GuessRequest(
        already_guessed=[],
        tenpai_declarer=0,
        declarer_closed=['1m', '2m', '3m', '1p', '2p', '3p', '1s', '2s', '3s', '东', '东', '东', '5m'],
        guesser_closed=['7m', '8m', '9m', '4p', '5p', '6p', '4s', '5s', '6s', '南', '南', '白', '白'],
        wall_draw_sequence=['9p', '9s', '北', '中', '7p', '5m'],
        dora_indicator='6p',
        rinshan_sequence=['西', '北'],
    )

    _setup_controlled_phase2(room.engine, 1, 0, req)

    assert room.engine.wall.dead_wall[0] // 4 == 29
    assert room.engine.wall.dead_wall[1] // 4 == 30
    assert room.engine.wall.dora_indicators[0] // 4 == 14

    room_manager.reset()


def test_setup_controlled_phase2_can_seed_open_pon_for_kakan():
    room = room_manager.create_room()
    room.add_player(1, 'p1', object())
    room.add_player(2, 'p2', object())

    req = Phase2GuessRequest(
        already_guessed=[],
        tenpai_declarer=0,
        declarer_closed=['1p', '2p', '3p', '1s', '2s', '3s', '东', '东', '东', '4m'],
        declarer_melds=[{'type': 'pon', 'tiles': ['5m', '5m', '5m'], 'called_index': 2}],
        guesser_closed=['7m', '8m', '9m', '4p', '5p', '6p', '4s', '5s', '6s', '南', '南', '白', '白'],
        wall_draw_sequence=['5m', '9p', '9s', '北', '中', '7p'],
        dora_indicator='6p',
        rinshan_sequence=['西'],
    )

    scenario = _setup_controlled_phase2(room.engine, 1, 0, req)

    assert scenario is not None
    assert len(room.engine.players[0].hand.closed) == 10
    assert len(room.engine.players[0].hand.melds) == 1
    assert room.engine.players[0].hand.melds[0].meld_type.value == 'pon'
    assert scenario['declarer_waits'] == [3]
    assert room.engine.wall.tiles[0] // 4 == 4
    assert room.engine.wall.dead_wall[0] // 4 == 29

    room_manager.reset()


def test_setup_controlled_phase1_action_populates_actions():
    room = room_manager.create_room()
    room.add_player(1, 'p1', object())
    room.add_player(2, 'p2', object())

    req = Phase1ActionStateRequest(
        actor_closed=['1m', '2m', '3m', '1p', '2p', '3p', '1s', '2s', '3s', '东', '东', '东', '5m'],
        actor_draw='5m',
        opponent_closed=['7m', '8m', '9m', '4p', '5p', '6p', '4s', '5s', '6s', '南', '南', '白', '白'],
        dora_indicator='6p',
    )

    scenario = _setup_controlled_phase1_action(room.engine, 0, req)

    assert room.engine.phase.value == 'phase1_action'
    assert room.engine.current_turn == 0
    assert room.engine.players[0].hand.draw_tile is not None
    assert scenario['actions']['must_discard'] is True
    assert scenario['actions']['can_tsumo'] is True

    room_manager.reset()


def test_setup_controlled_phase1_action_supports_red_dora_draw():
    room = room_manager.create_room()
    room.add_player(1, 'p1', object())
    room.add_player(2, 'p2', object())

    req = Phase1ActionStateRequest(
        actor_closed=['1m', '2m', '3m', '4p', '5p', '6p', '1s', '2s', '3s', '东', '东', '南', '南'],
        actor_draw='0m',
        opponent_closed=['7m', '8m', '9m', '4s', '5s', '6s', '白', '白', '发', '发', '中', '中', '北'],
        dora_indicator='6p',
    )

    _setup_controlled_phase1_action(room.engine, 0, req)

    assert room.engine.players[0].hand.draw_tile == 16
    assert room.engine.phase.value == 'phase1_action'

    room_manager.reset()