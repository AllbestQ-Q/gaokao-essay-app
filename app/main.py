# -*- coding: utf-8 -*-
"""高考满分作文智能应用 —— FastAPI 后端。

- POST /api/generate  流式生成作文（SSE）
- GET  /api/health    服务与配置状态
- GET  /api/patterns  满分作文规律分析报告（markdown）
- /                   静态前端页面
"""
import json
import os
import re
from pathlib import Path
from typing import AsyncIterator, Optional

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from openai import (
    APIConnectionError,
    APIStatusError,
    AsyncOpenAI,
    AuthenticationError,
    RateLimitError,
)
from pydantic import BaseModel, Field

from .prompt import build_messages

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

STATIC_DIR = Path(__file__).resolve().parent / "static"
PATTERNS_FILE = BASE_DIR / "patterns_analysis.md"

DEFAULT_BASE_URL = "https://api.openai.com/v1"
DEFAULT_MODEL = "gpt-4o-mini"

app = FastAPI(title="高考满分作文智能应用", version="1.0.0")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

_client: Optional[AsyncOpenAI] = None


def get_config() -> dict:
    return {
        "api_key": os.getenv("OPENAI_API_KEY", "").strip(),
        "base_url": os.getenv("OPENAI_BASE_URL", DEFAULT_BASE_URL).strip() or DEFAULT_BASE_URL,
        "model": os.getenv("OPENAI_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL,
    }


def get_client(cfg: dict) -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(api_key=cfg["api_key"], base_url=cfg["base_url"], timeout=180.0)
    return _client


class GenerateRequest(BaseModel):
    topic: str = Field(..., min_length=1, max_length=500, description="作文题目")
    material: str = Field("", max_length=4000, description="题目材料 / 写作要求（可选）")
    style: str = Field("auto", max_length=30, description="文体风格")


def sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def count_chars(text: str) -> int:
    """字数 = 非空白字符数（含标点，与高考卷面计数习惯一致）。"""
    return len(re.sub(r"\s", "", text))


def count_body_chars(text: str) -> int:
    """正文字数：去掉第一行标题后统计。"""
    lines = [line for line in text.splitlines() if line.strip()]
    body = "\n".join(lines[1:]) if len(lines) > 1 else ""
    return count_chars(body)


def friendly_error(exc: Exception) -> str:
    if isinstance(exc, AuthenticationError):
        return "API Key 无效或已过期，请检查 .env 中的 OPENAI_API_KEY。"
    if isinstance(exc, RateLimitError):
        return "触发接口限流或账户额度不足，请稍后重试。"
    if isinstance(exc, APIConnectionError):
        return "无法连接大模型服务，请检查网络或 OPENAI_BASE_URL 配置。"
    if isinstance(exc, APIStatusError):
        return f"大模型服务返回错误（HTTP {exc.status_code}）：{str(exc.message)[:200]}"
    return f"生成失败：{exc}"


async def event_stream(req: GenerateRequest) -> AsyncIterator[str]:
    cfg = get_config()
    if not cfg["api_key"] or cfg["api_key"].startswith("sk-your-key"):
        yield sse({
            "type": "error",
            "message": "尚未配置 OPENAI_API_KEY：请在 gaokao-essay-app/.env 中填写有效的 Key 后重启服务。",
        })
        return

    yield sse({"type": "meta", "model": cfg["model"]})
    messages = build_messages(req.topic, req.material, req.style)
    parts: list[str] = []
    try:
        client = get_client(cfg)
        kwargs: dict = {"model": cfg["model"], "messages": messages, "stream": True}
        temp = os.getenv("OPENAI_TEMPERATURE", "0.85").strip()
        if temp:
            kwargs["temperature"] = float(temp)
        stream = await client.chat.completions.create(**kwargs)
        try:
            async for chunk in stream:
                if not chunk.choices:
                    continue
                piece = getattr(chunk.choices[0].delta, "content", None)
                if piece:
                    parts.append(piece)
                    yield sse({"type": "delta", "text": piece})
        finally:
            await stream.close()
    except Exception as exc:  # noqa: BLE001 —— 统一转成 SSE 错误事件
        yield sse({"type": "error", "message": friendly_error(exc)})
        return

    full_text = "".join(parts)
    yield sse({
        "type": "done",
        "char_count": count_chars(full_text),
        "body_char_count": count_body_chars(full_text),
    })


@app.get("/api/health")
async def health():
    cfg = get_config()
    return {
        "status": "ok",
        "configured": bool(cfg["api_key"]) and not cfg["api_key"].startswith("sk-your-key"),
        "model": cfg["model"],
        "base_url": cfg["base_url"],
    }


@app.get("/api/patterns")
async def patterns():
    if PATTERNS_FILE.exists():
        return {"markdown": PATTERNS_FILE.read_text(encoding="utf-8")}
    return {"markdown": "# 满分作文规律\n\n分析报告尚未生成。"}


@app.post("/api/generate")
async def generate(req: GenerateRequest):
    return StreamingResponse(
        event_stream(req),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# 静态前端（最后挂载，避免覆盖 /api 路由）
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
