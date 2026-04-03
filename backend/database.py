import aiosqlite
import bcrypt
import os
from config import DATABASE_PATH, PLAYER1_USERNAME, PLAYER1_PASSWORD, PLAYER2_USERNAME, PLAYER2_PASSWORD

DB_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
);
"""


async def get_db() -> aiosqlite.Connection:
    os.makedirs(os.path.dirname(DATABASE_PATH) or ".", exist_ok=True)
    db = await aiosqlite.connect(DATABASE_PATH)
    db.row_factory = aiosqlite.Row
    return db


async def init_db():
    db = await get_db()
    try:
        await db.executescript(DB_SCHEMA)
        for username, password in [
            (PLAYER1_USERNAME, PLAYER1_PASSWORD),
            (PLAYER2_USERNAME, PLAYER2_PASSWORD),
        ]:
            row = await db.execute("SELECT id FROM users WHERE username = ?", (username,))
            if await row.fetchone() is None:
                pw_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
                await db.execute(
                    "INSERT INTO users (username, password_hash) VALUES (?, ?)",
                    (username, pw_hash),
                )
        await db.commit()
    finally:
        await db.close()


async def verify_user(username: str, password: str) -> dict | None:
    db = await get_db()
    try:
        cursor = await db.execute("SELECT id, username, password_hash FROM users WHERE username = ?", (username,))
        row = await cursor.fetchone()
        if row is None:
            return None
        if bcrypt.checkpw(password.encode(), row["password_hash"].encode()):
            return {"id": row["id"], "username": row["username"]}
        return None
    finally:
        await db.close()
