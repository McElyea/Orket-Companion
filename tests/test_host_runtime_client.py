from companion_extension.host_runtime_client import HostRuntimeClient


def test_layer_contract_host_runtime_client_builds_generic_extension_runtime_paths() -> None:
    client = HostRuntimeClient("http://127.0.0.1:8082", extension_id="orket.companion", api_key="core-key")

    assert client._path("/status") == "/v1/extensions/orket.companion/runtime/status"
    assert client._path("/tts/synthesize") == "/v1/extensions/orket.companion/runtime/tts/synthesize"
