"""
Room management for 2-player mahjong.
A room wraps a GameEngine and connects it to WebSocket messaging.
"""

from __future__ import annotations
import asyncio
from game.engine import GameEngine, Phase
from config import DEFAULT_TIMER_MINUTES


class Room:
    def __init__(self, room_id: str, timer_minutes: int = DEFAULT_TIMER_MINUTES):
        self.room_id = room_id
        self.engine = GameEngine(timer_minutes=timer_minutes)
        self.player_sockets: dict[int, object] = {}  # seat -> websocket
        self.user_to_seat: dict[int, int] = {}  # user_id -> seat
        self.ready_seats: set[int] = set()  # waiting-room ready states
        self.owner_user_id: int | None = None
        self._timer_task: asyncio.Task | None = None

        # Wire up engine notifications
        self.engine.set_notify(self._on_engine_notify)

    async def _on_engine_notify(self, event_type: str, data: dict, target_seat: int | None = None):
        """Dispatch engine events to WebSocket clients."""
        if target_seat is not None:
            ws = self.player_sockets.get(target_seat)
            if ws:
                await ws.send_json({"type": event_type, **data})
        else:
            # Broadcast to all
            for seat, ws in self.player_sockets.items():
                await ws.send_json({"type": event_type, **data})

        if event_type == "round_start":
            self.ready_seats.clear()
        elif event_type == "game_over":
            status_payload = {"type": "room_status", **self.waiting_status()}
            for ws in self.player_sockets.values():
                await ws.send_json(status_payload)

    def add_player(self, user_id: int, username: str, websocket) -> int | None:
        """Add a player to the room. Returns seat or None."""
        seat = self.engine.add_player(user_id, username)
        if seat is not None:
            self.player_sockets[seat] = websocket
            self.user_to_seat[user_id] = seat
            if self.owner_user_id is None:
                self.owner_user_id = user_id
            self.ready_seats.discard(seat)
        return seat

    def reconnect_player(self, user_id: int, websocket) -> int | None:
        """Reconnect an existing player with a new websocket."""
        seat = self.user_to_seat.get(user_id)
        if seat is not None:
            self.player_sockets[seat] = websocket
        return seat

    def remove_player(self, user_id: int):
        """Remove player socket (disconnect), but keep seat reserved for reconnect."""
        seat = self.user_to_seat.get(user_id)
        if seat is not None:
            self.player_sockets.pop(seat, None)
            self.ready_seats.discard(seat)
            if self.engine.phase == Phase.WAITING:
                self.engine._ready.discard(seat)

    def leave_player(self, user_id: int) -> bool:
        """Leave room before game start. Returns True if left, False if not allowed."""
        seat = self.user_to_seat.get(user_id)
        if seat is None:
            return False
        if self.engine.phase not in (Phase.WAITING, Phase.GAME_OVER):
            return False

        self.player_sockets.pop(seat, None)
        self.user_to_seat.pop(user_id, None)
        self.engine.players[seat] = None
        self.ready_seats.discard(seat)
        if self.owner_user_id == user_id:
            remaining_players = [p.user_id for p in self.engine.players if p is not None]
            self.owner_user_id = remaining_players[0] if remaining_players else None
        return True

    def is_empty(self) -> bool:
        return self.engine.players[0] is None and self.engine.players[1] is None

    async def try_start(self):
        """Start the game if both players are present."""
        ready_to_start = (
            self.engine.both_joined()
            and 0 in self.player_sockets
            and 1 in self.player_sockets
            and 0 in self.ready_seats
            and 1 in self.ready_seats
        )
        if not ready_to_start:
            return

        if self.engine.phase == Phase.GAME_OVER:
            self.reset_for_rematch()

        if self.engine.phase == Phase.WAITING:
            await self.engine.start_game()
            self._start_timer()

    def set_waiting_ready(self, user_id: int, ready: bool) -> bool:
        """Set player's waiting-room ready state. Returns False if not allowed."""
        seat = self.user_to_seat.get(user_id)
        if seat is None or self.engine.phase not in (Phase.WAITING, Phase.GAME_OVER):
            return False
        if ready:
            self.ready_seats.add(seat)
        else:
            self.ready_seats.discard(seat)
        return True

    def set_timer_minutes(self, user_id: int, timer_minutes: int) -> bool:
        """Update room timer configuration. Only the room owner can change it."""
        if self.owner_user_id != user_id:
            return False
        if self.engine.phase not in (Phase.WAITING, Phase.GAME_OVER):
            return False
        self.engine.timer_minutes = timer_minutes
        return True

    def reset_for_rematch(self):
        """Recreate the engine while keeping players and sockets in the same room."""
        timer_minutes = self.engine.timer_minutes
        existing_players = [
            (player.seat, player.user_id, player.username)
            for player in self.engine.players
            if player is not None
        ]

        self.engine = GameEngine(timer_minutes=timer_minutes)
        self.engine.set_notify(self._on_engine_notify)
        for seat, user_id, username in sorted(existing_players):
            new_seat = self.engine.add_player(user_id, username)
            if new_seat != seat:
                raise RuntimeError("重新建房后座位顺序不一致")

    def waiting_status(self) -> dict:
        players = []
        for p in self.engine.players:
            if p is None:
                continue
            players.append({
                "seat": p.seat,
                "username": p.username,
                "ready": p.seat in self.ready_seats,
            })
        return {
            "room_id": self.room_id,
            "phase": self.engine.phase.value,
            "players": players,
            "all_ready": self.engine.both_joined() and 0 in self.ready_seats and 1 in self.ready_seats,
            "owner_seat": self.user_to_seat.get(self.owner_user_id) if self.owner_user_id is not None else None,
            "timer_minutes": self.engine.timer_minutes,
        }

    def _start_timer(self):
        """Start periodic timer updates."""
        if self._timer_task is None or self._timer_task.done():
            self._timer_task = asyncio.create_task(self._timer_loop())

    async def _timer_loop(self):
        """Send timer updates every 5 seconds."""
        try:
            while not self.engine.game_over:
                remaining = self.engine.get_timer_remaining()
                for ws in self.player_sockets.values():
                    try:
                        await ws.send_json({
                            "type": "timer_update",
                            "remaining": remaining,
                            "is_last_round": self.engine.is_last_round,
                        })
                    except Exception:
                        pass
                await asyncio.sleep(5)
        except asyncio.CancelledError:
            pass
        finally:
            self._timer_task = None

    async def _send_to_seat(self, seat: int, data: dict):
        """Send a message to a player by seat index."""
        ws = self.player_sockets.get(seat)
        if ws:
            try:
                await ws.send_json(data)
            except Exception:
                pass

    async def handle_message(self, user_id: int, data: dict):
        """Route an incoming WebSocket message to the appropriate engine action."""
        seat = self.user_to_seat.get(user_id)
        if seat is None:
            return

        msg_type = data.get("type")
        engine = self.engine

        try:
            await self._route_message(seat, msg_type, data, engine)
        except Exception as e:
            import traceback
            traceback.print_exc()
            await self._send_to_seat(seat, {"type": "error", "message": "服务器处理请求时出错"})

    async def _route_message(self, seat: int, msg_type: str, data: dict, engine):
        """Route message to engine, with type validation."""
        if msg_type == "discard_tile":
            tile_id = data.get("tile")
            if not isinstance(tile_id, int):
                return
            if engine.phase == Phase.PHASE2_ACTION and engine.tenpai_declarer == seat:
                await engine.action_phase2_discard(seat, tile_id)
                return
            # If player declared tenpai this turn, use the tenpai discard path
            player = engine.players[seat]
            if player.declared_tenpai and engine.tenpai_declarer == seat and engine.phase == Phase.PHASE1_ACTION:
                await engine.action_discard_after_tenpai(seat, tile_id)
            else:
                await engine.action_discard(seat, tile_id)

        elif msg_type == "tsumo":
            await engine.action_tsumo(seat)

        elif msg_type == "ankan":
            tiles = data.get("tiles", [])
            if not isinstance(tiles, list) or not all(isinstance(t, int) for t in tiles):
                return
            await engine.action_ankan(seat, tiles)

        elif msg_type == "kakan":
            tile_id = data.get("tile")
            if not isinstance(tile_id, int):
                return
            await engine.action_kakan(seat, tile_id)

        elif msg_type == "declare_tenpai":
            await engine.action_declare_tenpai(seat)

        elif msg_type == "declare_riichi":
            await engine.action_declare_tenpai(seat, riichi=True)

        elif msg_type == "declare_damaten":
            await engine.action_declare_damaten(seat)

        elif msg_type == "call_pass":
            await engine.response_pass(seat)

        elif msg_type == "call_ron":
            await engine.response_ron(seat)

        elif msg_type == "call_chi":
            own_tiles = data.get("tiles", [])
            if not isinstance(own_tiles, list) or not all(isinstance(t, int) for t in own_tiles):
                return
            await engine.response_chi(seat, own_tiles)

        elif msg_type == "call_pon":
            await engine.response_pon(seat)

        elif msg_type == "call_minkan":
            await engine.response_minkan(seat)

        elif msg_type == "phase2_guess":
            guessed = data.get("tiles", [])
            if not isinstance(guessed, list) or not all(isinstance(t, int) for t in guessed):
                return
            await engine.phase2_guess(seat, guessed)

        elif msg_type == "phase2_next_draw":
            await engine.phase2_next_draw(seat)

        elif msg_type == "ready":
            await engine.player_ready(seat)

        elif msg_type == "get_state":
            state = engine.get_state_for_player(seat)
            ws = self.player_sockets.get(seat)
            if ws:
                await ws.send_json({"type": "game_state", **state})

    @property
    def is_full(self) -> bool:
        return self.engine.both_joined()

    @property
    def is_game_over(self) -> bool:
        return self.engine.game_over

    def to_dict(self) -> dict:
        return {
            "room_id": self.room_id,
            "players": [
                {"username": p.username, "seat": p.seat} if p else None
                for p in self.engine.players
            ],
            "phase": self.engine.phase.value,
            "is_full": self.is_full,
        }


class RoomManager:
    """Manages all active rooms (for 2-player, typically just one)."""

    def __init__(self):
        self.rooms: dict[str, Room] = {}
        self._counter = 0

    def create_room(self, timer_minutes: int = DEFAULT_TIMER_MINUTES) -> Room:
        self._counter += 1
        room_id = f"room_{self._counter}"
        room = Room(room_id, timer_minutes)
        self.rooms[room_id] = room
        return room

    def get_room(self, room_id: str) -> Room | None:
        return self.rooms.get(room_id)

    def find_waiting_room(self) -> Room | None:
        """Find a room that's waiting for players."""
        for room in self.rooms.values():
            if not room.is_full and not room.is_game_over:
                return room
        return None

    def get_player_room(self, user_id: int) -> Room | None:
        """Find the room a player is in."""
        for room in self.rooms.values():
            if user_id in room.user_to_seat:
                return room
        return None

    def list_rooms(self) -> list[dict]:
        self.cleanup_finished()
        return [r.to_dict() for r in self.rooms.values() if not r.is_game_over]

    def cleanup_finished(self):
        """Remove rooms that are no longer referenced by any seated players."""
        to_remove = [rid for rid, r in self.rooms.items() if r.is_empty()]
        for rid in to_remove:
            del self.rooms[rid]

    def remove_room_if_empty(self, room_id: str):
        room = self.rooms.get(room_id)
        if room and room.is_empty():
            del self.rooms[room_id]

    def reset(self):
        """Clear all rooms. Intended for E2E test setup only."""
        self.rooms.clear()
        self._counter = 0


# Global singleton
room_manager = RoomManager()
