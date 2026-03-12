import pytest
from pydantic import ValidationError

from companion_app.server import SynthesizeRequest, _resolve_host_api_base_url, _resolve_host_api_key


def test_layer_contract_resolve_host_api_base_url_defaults_to_orket_server_port(monkeypatch) -> None:
    monkeypatch.delenv("COMPANION_HOST_BASE_URL", raising=False)
    assert _resolve_host_api_base_url() == "http://127.0.0.1:8082"


def test_layer_contract_resolve_host_api_key_uses_companion_specific_fallbacks(monkeypatch) -> None:
    monkeypatch.delenv("COMPANION_API_KEY", raising=False)
    monkeypatch.setenv("ORKET_COMPANION_API_KEY", "companion-key")
    monkeypatch.setenv("ORKET_API_KEY", "core-key")
    assert _resolve_host_api_key() == "companion-key"


def test_layer_contract_resolve_host_api_key_falls_back_to_default_host_key(monkeypatch) -> None:
    monkeypatch.delenv("COMPANION_API_KEY", raising=False)
    monkeypatch.delenv("ORKET_COMPANION_API_KEY", raising=False)
    monkeypatch.setenv("ORKET_API_KEY", "core-key")
    assert _resolve_host_api_key() == "core-key"


def test_layer_contract_synthesize_request_accepts_full_gateway_text_budget() -> None:
    request = SynthesizeRequest(text="x" * 3000)
    assert request.text == "x" * 3000


def test_layer_contract_synthesize_request_rejects_text_over_field_budget() -> None:
    with pytest.raises(ValidationError):
        SynthesizeRequest(text="x" * 4001)
