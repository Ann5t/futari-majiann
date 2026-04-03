import os
import secrets

def _get_secret_key() -> str:
    """Get a stable secret key: env var > file > generate and save."""
    env_key = os.environ.get("SECRET_KEY")
    if env_key:
        return env_key
    key_path = os.path.join(os.path.dirname(__file__), "data", ".secret_key")
    try:
        with open(key_path) as f:
            return f.read().strip()
    except FileNotFoundError:
        key = secrets.token_hex(32)
        os.makedirs(os.path.dirname(key_path), exist_ok=True)
        with open(key_path, "w") as f:
            f.write(key)
        return key

SECRET_KEY = _get_secret_key()
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_HOURS = 24

DATABASE_PATH = os.environ.get("DATABASE_PATH", "data/mahjong.db")

PLAYER1_USERNAME = os.environ.get("PLAYER1_USERNAME", "player1")
PLAYER1_PASSWORD = os.environ.get("PLAYER1_PASSWORD", "pass1")
PLAYER2_USERNAME = os.environ.get("PLAYER2_USERNAME", "player2")
PLAYER2_PASSWORD = os.environ.get("PLAYER2_PASSWORD", "pass2")

DEFAULT_TIMER_MINUTES = int(os.environ.get("DEFAULT_TIMER_MINUTES", "30"))
E2E_ENABLE_TEST_HOOKS = os.environ.get("E2E_ENABLE_TEST_HOOKS", "0") == "1"
STARTING_POINTS = 25000
