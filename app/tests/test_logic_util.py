"""shrine.logic.util(한국 시간 날짜)을 예전 Node server/util.ts와 맞춰 봅니다. 기준값은 tests/data/golden의 Node 골든(git 기록 a2b1bf6까지의 Node 서버에서 뽑음)입니다."""

from __future__ import annotations

import random

from golden import run

from shrine.logic import util as U


def test_kst_dates_match_node() -> None:
    rng = random.Random(61)
    day = U.DAY_MS
    kst = U.KST_OFFSET_MS
    nows = [0, -1, 1, kst - 1, -kst, -kst - 1, -kst + 1, 1763478000000, 1763477999999, 1763391600000, 253402300799999, -62135596800000,
            -62167219200000 - kst, 8.64e15 - kst, -8.64e15 + kst, 951782400000 - kst, 951868800000 - kst, 1709164800000 - kst]  # fmt: skip
    nows += [rng.randint(-2_000_000_000_000, 4_000_000_000_000) for _ in range(3000)]
    nows += [k * day - kst + d for k in range(20000, 20020) for d in (-1, 0, 1)]
    nows = [int(n) for n in nows]
    dates = ["2026-11-18", "2026-11-19", "2026-02-30", "2024-02-29", "2023-02-29", "2024-13-01", "2024-00-10", "2024-01-00", "2024-01-32",
             "2024-04-31", "0000-01-01", "9999-12-31", "1900-02-29", "2026-1-1", "2026/01/01", "", "abcd-ef-gh", "+02026-01-01", "+010000-01",
             "2026", "2026-11", "-000001-01-01", "-000000-01-01", "+275760-09-13", "+275760-09-14", "10000-01-01", "2026-11-18x"]  # fmt: skip
    pairs = [[d, n] for d in dates for n in nows[:40]]
    pairs += [[f"{rng.randint(1970, 2100):04d}-{rng.randint(1, 12):02d}-{rng.randint(1, 31):02d}", rng.randint(0, 4_000_000_000_000)] for _ in range(3000)]
    node = run("util", nows=nows, dates=pairs)

    def safe(f):  # noqa: ANN001, ANN202
        try:
            return f()
        except ValueError:
            return "ERR RangeError"  # JS toISOString의 RangeError (±8.64e15 ms 밖)

    assert [safe(lambda: U.kst_date(n)) for n in nows] == node["kstDate"]
    assert [safe(lambda: U.kst_days_back(3, n)) for n in nows] == node["daysBack"]
    assert [safe(lambda: U.kst_week_days(n)) for n in nows] == node["week"]
    for (d, n), want in zip(pairs, node["since"], strict=True):
        got = safe(lambda: U.days_since(d, n))  # noqa: B023
        assert (None if got != got else got) == want, (d, n)
