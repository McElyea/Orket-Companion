from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from threading import Lock
from typing import Any, TypedDict


class AvatarControlEventEnvelopeV1(TypedDict):
    type: str
    version: str
    session_id: str
    ts: str
    idempotency_key: str
    payload: dict[str, Any]


def parse_avatar_control_event_envelope(input_value: Any) -> tuple[bool, AvatarControlEventEnvelopeV1 | None, str | None]:
    if not isinstance(input_value, dict):
        return False, None, "avatar_event_payload_invalid"

    event_type = str(input_value.get("type", "")).strip()
    version = str(input_value.get("version", "")).strip()
    session_id = str(input_value.get("session_id", "")).strip()
    ts = str(input_value.get("ts", "")).strip()
    idempotency_key = str(input_value.get("idempotency_key", "")).strip()
    payload = input_value.get("payload")

    if not event_type or not session_id or not ts or not idempotency_key or not isinstance(payload, dict) or not payload:
        return False, None, "avatar_event_required_fields_missing"
    if version != "avatar_event_v1":
        return False, None, "avatar_event_version_unsupported"

    return (
        True,
        AvatarControlEventEnvelopeV1(
            type=event_type,
            version="avatar_event_v1",
            session_id=session_id,
            ts=ts,
            idempotency_key=idempotency_key,
            payload=payload,
        ),
        None,
    )


@dataclass(frozen=True)
class StoredAvatarControlEvent:
    seq: int
    event: AvatarControlEventEnvelopeV1


@dataclass
class _SessionEventState:
    next_seq: int = 1
    events: deque[StoredAvatarControlEvent] = field(default_factory=deque)
    seen_keys: set[str] = field(default_factory=set)
    key_order: deque[str] = field(default_factory=deque)
    key_to_seq: dict[str, int] = field(default_factory=dict)


class InMemoryAvatarControlEventStore:
    def __init__(
        self,
        *,
        max_events_per_session: int = 256,
        max_idempotency_keys_per_session: int = 512,
    ) -> None:
        self._max_events_per_session = max(32, int(max_events_per_session))
        self._max_idempotency_keys_per_session = max(64, int(max_idempotency_keys_per_session))
        self._sessions: dict[str, _SessionEventState] = {}
        self._lock = Lock()

    def publish(self, event: AvatarControlEventEnvelopeV1) -> dict[str, Any]:
        session_id = str(event.get("session_id", "")).strip()
        idempotency_key = str(event.get("idempotency_key", "")).strip()
        if not session_id or not idempotency_key:
            return {"accepted": False, "duplicate": False, "seq": None}

        with self._lock:
            state = self._sessions.setdefault(session_id, _SessionEventState())
            existing_seq = state.key_to_seq.get(idempotency_key)
            if existing_seq is not None:
                return {"accepted": True, "duplicate": True, "seq": existing_seq}

            seq = state.next_seq
            state.next_seq += 1
            state.events.append(StoredAvatarControlEvent(seq=seq, event=event))
            if len(state.events) > self._max_events_per_session:
                state.events.popleft()

            state.seen_keys.add(idempotency_key)
            state.key_order.append(idempotency_key)
            state.key_to_seq[idempotency_key] = seq
            while len(state.key_order) > self._max_idempotency_keys_per_session:
                oldest = state.key_order.popleft()
                if oldest:
                    state.seen_keys.discard(oldest)
                    state.key_to_seq.pop(oldest, None)
            return {"accepted": True, "duplicate": False, "seq": seq}

    def list_events(self, *, session_id: str, after_seq: int = 0, limit: int = 50) -> dict[str, Any]:
        normalized_session = str(session_id or "").strip()
        normalized_after = max(0, int(after_seq))
        normalized_limit = max(1, min(200, int(limit)))

        with self._lock:
            state = self._sessions.get(normalized_session)
            if not state:
                return {"events": [], "latest_seq": 0}

            latest_seq = state.next_seq - 1
            selected_events: list[dict[str, Any]] = []
            for item in state.events:
                if item.seq <= normalized_after:
                    continue
                selected_events.append({"seq": item.seq, **item.event})
                if len(selected_events) >= normalized_limit:
                    break
            return {"events": selected_events, "latest_seq": latest_seq}
