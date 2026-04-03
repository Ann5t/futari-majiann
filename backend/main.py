from contextlib import asynccontextmanager
import mimetypes
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi import Response
from models import LoginRequest, LoginResponse
from database import init_db, verify_user
from auth import create_token
from config import E2E_ENABLE_TEST_HOOKS
from ws_handler import router as ws_router
import os


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")

mimetypes.add_type("audio/wav", ".wav")





def create_app(enable_test_hooks: bool | None = None) -> FastAPI:
    app = FastAPI(lifespan=lifespan)
    app.include_router(ws_router)

    if enable_test_hooks is None:
        enable_test_hooks = E2E_ENABLE_TEST_HOOKS
    if enable_test_hooks:
        from test_hooks import router as test_hooks_router

        app.include_router(test_hooks_router)

    @app.post("/api/login", response_model=LoginResponse)
    async def login(req: LoginRequest):
        user = await verify_user(req.username, req.password)
        if user is None:
            raise HTTPException(status_code=401, detail="用户名或密码错误")
        token = create_token(user)
        return LoginResponse(token=token, username=user["username"])

    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

    @app.get("/")
    async def index():
        return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))

    @app.get("/lobby")
    async def lobby():
        return FileResponse(os.path.join(FRONTEND_DIR, "lobby.html"))

    @app.get("/game")
    async def game():
        return FileResponse(os.path.join(FRONTEND_DIR, "game.html"))

    @app.get("/favicon.ico")
    async def favicon():
        return Response(status_code=204)

    return app


app = create_app()
