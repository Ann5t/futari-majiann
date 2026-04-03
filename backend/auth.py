import jwt
import datetime
from fastapi import HTTPException, WebSocket
from config import SECRET_KEY, JWT_ALGORITHM, JWT_EXPIRE_HOURS


def create_token(user: dict) -> str:
    payload = {
        "sub": str(user["id"]),
        "username": user["username"],
        "exp": datetime.datetime.now(datetime.timezone.utc)
        + datetime.timedelta(hours=JWT_EXPIRE_HOURS),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="登录已过期")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="无效的登录凭证")


def get_http_user(authorization: str | None) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="缺少登录凭证")
    token = authorization.split(" ", 1)[1].strip()
    payload = decode_token(token)
    return {"id": int(payload["sub"]), "username": payload["username"]}


async def get_ws_user(websocket: WebSocket) -> dict:
    token = websocket.query_params.get("token")
    if not token:
        await websocket.close(code=4001, reason="Missing token")
        raise Exception("Missing token")
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[JWT_ALGORITHM])
        return {"id": int(payload["sub"]), "username": payload["username"]}
    except Exception:
        await websocket.close(code=4001, reason="Invalid token")
        raise Exception("Invalid token")
