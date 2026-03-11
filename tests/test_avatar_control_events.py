from companion_app.avatar_control_events import (
    InMemoryAvatarControlEventStore,
    parse_avatar_control_event_envelope,
)


def _event(*, idempotency_key: str, session_id: str = "session-1") -> dict:
    return {
        "type": "avatar.expression",
        "version": "avatar_event_v1",
        "session_id": session_id,
        "ts": "2026-03-11T00:00:00.000Z",
        "idempotency_key": idempotency_key,
        "payload": {"expression": "smile"},
    }


def test_parse_avatar_control_event_envelope_accepts_valid_v1() -> None:
    ok, event, error = parse_avatar_control_event_envelope(_event(idempotency_key="k-1"))
    assert ok is True
    assert error is None
    assert event is not None
    assert event["version"] == "avatar_event_v1"


def test_parse_avatar_control_event_envelope_rejects_unsupported_version() -> None:
    bad = _event(idempotency_key="k-2")
    bad["version"] = "avatar_event_v2"
    ok, event, error = parse_avatar_control_event_envelope(bad)
    assert ok is False
    assert event is None
    assert error == "avatar_event_version_unsupported"


def test_store_publish_is_idempotent_by_key() -> None:
    store = InMemoryAvatarControlEventStore(max_events_per_session=16, max_idempotency_keys_per_session=16)
    first = store.publish(_event(idempotency_key="same-key"))  # type: ignore[arg-type]
    second = store.publish(_event(idempotency_key="same-key"))  # type: ignore[arg-type]
    assert first["accepted"] is True
    assert first["duplicate"] is False
    assert second["accepted"] is True
    assert second["duplicate"] is True
    assert first["seq"] == second["seq"]


def test_store_feed_returns_only_events_after_requested_sequence() -> None:
    store = InMemoryAvatarControlEventStore(max_events_per_session=16, max_idempotency_keys_per_session=16)
    store.publish(_event(idempotency_key="k-1"))  # type: ignore[arg-type]
    store.publish(_event(idempotency_key="k-2"))  # type: ignore[arg-type]
    store.publish(_event(idempotency_key="k-3"))  # type: ignore[arg-type]

    feed = store.list_events(session_id="session-1", after_seq=1, limit=10)
    assert feed["latest_seq"] == 3
    assert [entry["idempotency_key"] for entry in feed["events"]] == ["k-2", "k-3"]
