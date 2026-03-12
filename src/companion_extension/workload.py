from __future__ import annotations

from typing import Any

from orket_extension_sdk.result import WorkloadResult


def run(ctx: Any, payload: dict[str, Any]) -> WorkloadResult:
    """Template workload entrypoint.

    Replace this logic with real extension behavior. Keep runtime authority
    interactions behind SDK capability calls.
    """
    return WorkloadResult(
        ok=True,
        output={"echo": payload},
        artifacts=[],
        issues=[],
    )
