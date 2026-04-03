from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from auth import get_ws_user
from game.room import room_manager

router = APIRouter()


class ConnectionManager:
    def __init__(self):
        self.connections: dict[int, WebSocket] = {}

    async def connect(self, user_id: int, websocket: WebSocket):
        await websocket.accept()
        self.connections[user_id] = websocket

    def disconnect(self, user_id: int):
        self.connections.pop(user_id, None)

    async def send_json(self, user_id: int, data: dict):
        ws = self.connections.get(user_id)
        if ws:
            await ws.send_json(data)

    async def broadcast(self, data: dict):
        for ws in self.connections.values():
            await ws.send_json(data)


manager = ConnectionManager()


async def send_room_status(room):
    payload = {"type": "room_status", **room.waiting_status()}
    for ws in room.player_sockets.values():
        try:
            await ws.send_json(payload)
        except Exception:
            pass


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    try:
        user = await get_ws_user(websocket)
    except Exception:
        return

    user_id = user["id"]
    username = user["username"]
    await manager.connect(user_id, websocket)

    try:
        # Check if player is already in a room (reconnect)
        existing_room = room_manager.get_player_room(user_id)
        if existing_room:
            existing_room.reconnect_player(user_id, websocket)
            seat = existing_room.user_to_seat[user_id]
            state = existing_room.engine.get_state_for_player(seat)
            await websocket.send_json({"type": "game_state", **state})
            await websocket.send_json({"type": "room_status", **existing_room.waiting_status()})

        # Notify lobby
        await manager.broadcast({
            "type": "player_online",
            "username": username,
            "online_players": list(manager.connections.keys()),
            "rooms": room_manager.list_rooms(),
        })

        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")

            if msg_type == "ping":
                await manager.send_json(user_id, {"type": "pong"})

            elif msg_type == "create_room":
                timer = data.get("timer_minutes", 30)
                room = room_manager.create_room(timer_minutes=timer)
                seat = room.add_player(user_id, username, websocket)
                await websocket.send_json({
                    "type": "room_created",
                    "room": room.to_dict(),
                    "seat": seat,
                })
                await manager.broadcast({
                    "type": "rooms_update",
                    "rooms": room_manager.list_rooms(),
                })
                await send_room_status(room)

            elif msg_type == "join_room":
                room_id = data.get("room_id")
                room = room_manager.get_room(room_id) if room_id else room_manager.find_waiting_room()
                if room is None:
                    await websocket.send_json({"type": "error", "message": "房间不存在"})
                    continue
                if room.is_full:
                    await websocket.send_json({"type": "error", "message": "房间已满"})
                    continue
                seat = room.add_player(user_id, username, websocket)
                if seat is None:
                    await websocket.send_json({"type": "error", "message": "无法加入"})
                    continue
                await websocket.send_json({
                    "type": "room_joined",
                    "room": room.to_dict(),
                    "seat": seat,
                })
                await manager.broadcast({
                    "type": "rooms_update",
                    "rooms": room_manager.list_rooms(),
                })
                await send_room_status(room)

            elif msg_type == "list_rooms":
                await websocket.send_json({
                    "type": "rooms_list",
                    "rooms": room_manager.list_rooms(),
                })

            elif msg_type == "get_room_status":
                room = room_manager.get_player_room(user_id)
                if room:
                    await websocket.send_json({"type": "room_status", **room.waiting_status()})

            elif msg_type == "room_ready":
                room = room_manager.get_player_room(user_id)
                if room is None:
                    await websocket.send_json({"type": "error", "message": "你不在任何房间"})
                    continue
                if not room.set_waiting_ready(user_id, True):
                    await websocket.send_json({"type": "error", "message": "当前阶段无法准备"})
                    continue
                await send_room_status(room)
                await room.try_start()

            elif msg_type == "room_unready":
                room = room_manager.get_player_room(user_id)
                if room is None:
                    await websocket.send_json({"type": "error", "message": "你不在任何房间"})
                    continue
                if not room.set_waiting_ready(user_id, False):
                    await websocket.send_json({"type": "error", "message": "当前阶段无法取消准备"})
                    continue
                await send_room_status(room)

            elif msg_type == "leave_room":
                room = room_manager.get_player_room(user_id)
                if room is None:
                    await websocket.send_json({"type": "room_left"})
                    continue

                left = room.leave_player(user_id)
                if not left:
                    await websocket.send_json({"type": "error", "message": "对局已开始，无法退出房间"})
                    continue

                room_manager.remove_room_if_empty(room.room_id)
                await websocket.send_json({"type": "room_left"})
                await send_room_status(room)
                await manager.broadcast({
                    "type": "rooms_update",
                    "rooms": room_manager.list_rooms(),
                })

            else:
                # Game messages → route to the player's room
                room = room_manager.get_player_room(user_id)
                if room:
                    await room.handle_message(user_id, data)

    except WebSocketDisconnect:
        manager.disconnect(user_id)
        room = room_manager.get_player_room(user_id)
        if room:
            # Keep room reservation for reconnect (including lobby->game navigation).
            room.remove_player(user_id)
        await manager.broadcast({
            "type": "player_offline",
            "username": username,
            "online_players": list(manager.connections.keys()),
        })
