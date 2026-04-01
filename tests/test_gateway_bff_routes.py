from __future__ import annotations

from fastapi.testclient import TestClient

from companion_app.server import app

_SAME_ORIGIN_HEADERS = {"origin": "http://testserver"}


def test_layer_integration_gateway_chat_and_config_routes_use_bff_client(monkeypatch) -> None:
    class _FakeClient:
        def __init__(self) -> None:
            self.last_update_config: dict[str, object] = {}
            self.last_chat: dict[str, object] = {}

        async def get_config(self, *, session_id: str) -> dict[str, object]:
            return {
                "ok": True,
                "session_id": session_id,
                "config": {
                    "mode": {"role_id": "general_assistant", "relationship_style": "platonic"},
                    "memory": {
                        "session_memory_enabled": True,
                        "profile_memory_enabled": True,
                        "episodic_memory_enabled": False,
                    },
                    "voice": {
                        "enabled": False,
                        "silence_delay_sec": 1.5,
                        "silence_delay_min_sec": 0.2,
                        "silence_delay_max_sec": 10.0,
                        "adaptive_cadence_enabled": False,
                        "adaptive_cadence_min_sec": 0.4,
                        "adaptive_cadence_max_sec": 4.0,
                    },
                },
            }

        async def update_config(self, *, session_id: str, scope: str, patch: dict[str, object]) -> dict[str, object]:
            self.last_update_config = {"session_id": session_id, "scope": scope, "patch": patch}
            return {"ok": True, "session_id": session_id, "scope": scope, "config": patch}

        async def chat(
            self,
            *,
            session_id: str,
            message: str,
            provider: str = "",
            model: str = "",
        ) -> dict[str, object]:
            self.last_chat = {
                "session_id": session_id,
                "message": message,
                "provider": provider,
                "model": model,
            }
            return {
                "ok": True,
                "session_id": session_id,
                "turn_id": "turn.000001",
                "message": "hello from fake bff",
                "model": model or "fake-model",
                "latency_ms": 5,
                "text_only_degraded": False,
            }

    fake_client = _FakeClient()
    monkeypatch.setattr("companion_app.server._client", lambda: fake_client)
    client = TestClient(app)

    config = client.get("/api/config", params={"session_id": "session-1"})
    patched = client.patch(
        "/api/config",
        headers=_SAME_ORIGIN_HEADERS,
        json={"session_id": "session-1", "scope": "next_turn", "patch": {"mode": {"role_id": "researcher"}}},
    )
    chat = client.post(
        "/api/chat",
        headers=_SAME_ORIGIN_HEADERS,
        json={"session_id": "session-1", "message": "hello", "provider": "ollama", "model": "qwen2.5-coder:7b"},
    )

    assert config.status_code == 200
    assert patched.status_code == 200
    assert chat.status_code == 200
    assert fake_client.last_update_config == {
        "session_id": "session-1",
        "scope": "next_turn",
        "patch": {"mode": {"role_id": "researcher"}},
    }
    assert fake_client.last_chat == {
        "session_id": "session-1",
        "message": "hello",
        "provider": "ollama",
        "model": "qwen2.5-coder:7b",
    }


def test_layer_contract_gateway_requires_host_api_key(monkeypatch) -> None:
    monkeypatch.delenv("COMPANION_API_KEY", raising=False)
    monkeypatch.delenv("ORKET_API_KEY", raising=False)
    client = TestClient(app)

    response = client.get("/api/status")

    assert response.status_code == 503
    detail = response.json()["detail"]
    assert detail["ok"] is False
    assert detail["code"] == "E_COMPANION_GATEWAY_API_KEY_REQUIRED"


def test_layer_integration_gateway_voice_routes_use_bff_client(monkeypatch) -> None:
    class _FakeClient:
        async def voice_voices(self) -> dict[str, object]:
            return {
                "ok": True,
                "tts_available": True,
                "default_voice_id": "demo_voice",
                "voices": [
                    {
                        "voice_id": "demo_voice",
                        "display_name": "Demo Voice",
                        "language": "en",
                        "tags": ["test"],
                    }
                ],
            }

        async def voice_synthesize(
            self,
            *,
            text: str,
            voice_id: str = "",
            emotion_hint: str = "neutral",
            speed: float = 1.0,
        ) -> dict[str, object]:
            return {
                "ok": bool(text),
                "voice_id": voice_id or "demo_voice",
                "emotion_hint": emotion_hint,
                "speed": speed,
                "sample_rate": 22050,
                "channels": 1,
                "format": "pcm_s16le",
                "audio_b64": "AQI=",
                "error_code": None,
                "error_message": "",
            }

    monkeypatch.setattr("companion_app.server._client", lambda: _FakeClient())
    client = TestClient(app)

    voices = client.get("/api/voice/voices")
    synth = client.post(
        "/api/voice/synthesize",
        headers=_SAME_ORIGIN_HEADERS,
        json={"text": "Hello synth", "voice_id": "demo_voice", "emotion_hint": "calm", "speed": 1.2},
    )

    assert voices.status_code == 200
    assert synth.status_code == 200
    assert voices.json()["voices"][0]["voice_id"] == "demo_voice"
    assert synth.json()["voice_id"] == "demo_voice"
