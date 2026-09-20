"""现场决策投票服务端语义的无第三方依赖验证（python3 tests/test_polls.py）。

不导入 app.main（其依赖 fastapi，本地最小环境可能缺失），而是直接在 SQLite
上调用真实的纯逻辑模块 app.polls（main.py 的 REST / ticker 走的就是同一份
代码）与 app.db 建表/迁移，校验：

1. 创建与投票：2～4 选项、参与名单、每组只计一票（改投覆盖、不留多行）；
2. 截止与一次性结算：未到截止不结算；到期最高票获胜，平票按选项创建顺序，
   0 票时首个选项获胜；结算持久化，再次扫描 / 重启不重复结算；
3. 暂停冻结：结算只看调用方传入的虚拟毫秒——ticker 只扫描 running 房间，
   暂停时传入冻结值，截止计时不推进；
4. 视野：主持人见逐组选票与汇总；参与者投票中只见自己选择（无票数），
   结算后才见票数与获胜选项（仍无逐组选票）；非参与组 / 已作废返回 None；
   事件投影（poll_created/poll_voted/poll_settled/polls_reset）不泄露
   他组名单、group_id 或 ballots，非参与组收不到事件；
5. 重置：未结算投票判废（选票留痕），已结算结果按轮次保留；
   参与者只看本轮且本组在参与名单内的投票；
6. 迁移：旧库（无任何投票表）走 init_schema 后投票表可用，既有数据不丢。
"""
import os
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import db as dbmod  # noqa: E402
from app import polls as P  # noqa: E402


def open_db(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    dbmod.init_schema(conn)
    return conn


def make_room(conn, code="POL001", status="running", elapsed_ms=0, now=1000.0):
    rid = conn.execute(
        "INSERT INTO rooms (code,name,status,elapsed_ms,last_resume_at,created_at)"
        " VALUES (?,?,?,?,?,?)",
        (code, "投票房", status, elapsed_ms, now if status == "running" else None, now),
    ).lastrowid
    conn.commit()
    return rid


def add_groups(conn, rid, names):
    ids = []
    for i, name in enumerate(names):
        gid = conn.execute(
            "INSERT INTO groups (room_id,name,join_code,created_at) VALUES (?,?,?,?)",
            (rid, name, f"G{i:05d}", 1000.0),
        ).lastrowid
        ids.append(gid)
    conn.commit()
    return ids


def test_create_and_one_vote_per_group():
    with tempfile.TemporaryDirectory() as d:
        conn = open_db(os.path.join(d, "t.db"))
        rid = make_room(conn)
        g1, g2, g3 = add_groups(conn, rid, ["红", "蓝", "绿"])
        poll = P.create_poll(conn, rid, 0, "切流?", 30, [g1, g2],
                             ["立即切流", "继续观察"], 1000.0)
        pid = poll["id"]
        o1, o2 = P.option_rows(conn, pid)

        # 选项创建顺序 (seq, id)
        assert [o["seq"] for o in (o1, o2)] == [1, 2]
        assert P.participant_ids(conn, pid) == [g1, g2]
        assert P.is_participant(conn, pid, g1) and not P.is_participant(conn, pid, g3)

        # g1 投 o1；g2 先投 o2 再改投 o1：每组只保留一行，只计一票
        P.cast_vote(conn, poll, g1, o1["id"], 1001.0)
        P.cast_vote(conn, P.get_poll(conn, pid), g2, o2["id"], 1002.0)
        P.cast_vote(conn, P.get_poll(conn, pid), g2, o1["id"], 1003.0)
        assert conn.execute(
            "SELECT COUNT(*) c FROM poll_votes WHERE poll_id=?", (pid,)).fetchone()["c"] == 2
        hv = P.host_view(conn, P.get_poll(conn, pid))
        assert [o["votes"] for o in hv["options"]] == [2, 0]
        # 逐组选票反映改投后的最新选项
        assert {b["group_id"]: b["option_id"] for b in hv["ballots"]} == {g1: o1["id"], g2: o1["id"]}
        conn.close()
    print("ok: create poll and one vote per group (change-vote overwrites)")


def test_deadline_and_one_shot_settlement():
    with tempfile.TemporaryDirectory() as d:
        conn = open_db(os.path.join(d, "t.db"))
        rid = make_room(conn)
        g1, g2, g3, g4 = add_groups(conn, rid, ["红", "蓝", "绿", "黄"])

        # 2:1 多数
        p1 = P.create_poll(conn, rid, 0, "多数", 30, [g1, g2, g3], ["A", "B"], 1000.0)
        a, b = P.option_rows(conn, p1["id"])
        P.cast_vote(conn, p1, g1, b["id"], 1001.0)
        P.cast_vote(conn, p1, g2, a["id"], 1001.0)
        P.cast_vote(conn, p1, g3, a["id"], 1001.0)

        # 平票：按选项创建顺序（seq 更小）获胜
        p2 = P.create_poll(conn, rid, 0, "平票", 10, [g1, g2, g3, g4], ["X", "Y"], 1000.0)
        x, y = P.option_rows(conn, p2["id"])
        P.cast_vote(conn, p2, g1, x["id"], 1001.0)
        P.cast_vote(conn, p2, g2, y["id"], 1001.0)

        # 0 票：首个选项获胜（在截止秒边界 5000 上）
        p3 = P.create_poll(conn, rid, 0, "无人", 5, [g1], ["P", "Q"], 1000.0)
        p_first = P.option_rows(conn, p3["id"])[0]

        # 未到截止（<5s）：一个都不结算
        assert P.settle_due_polls(conn, rid, 4999, 1004.0) == []
        assert P.get_poll(conn, p1["id"])["status"] == P.POLL_OPEN
        assert P.get_poll(conn, p2["id"])["status"] == P.POLL_OPEN

        # 5s：p3（截止 5s）到期立即结算（0 票 → 首项获胜）
        at5 = P.settle_due_polls(conn, rid, 5000, 1005.0)
        assert [s["id"] for s in at5] == [p3["id"]]
        assert at5[0]["winner_option_id"] == p_first["id"]
        assert at5[0]["settled_at_ms"] == 5000

        # 10s：p2（10s）到期；p1（30s）未到期；p3 已一次性结算不再出现
        settled = P.settle_due_polls(conn, rid, 10000, 1010.0)
        assert [s["id"] for s in settled] == [p2["id"]]
        by_id = {s["id"]: s for s in settled}
        assert by_id[p2["id"]]["winner_option_id"] == x["id"]  # 平票 → 创建顺序在前
        assert [o["votes"] for o in by_id[p2["id"]]["options"]] == [1, 1]

        # 30s：p1 到期，B 得 1 票但 A 得 2 票 → A 获胜
        settled1 = P.settle_due_polls(conn, rid, 30000, 1030.0)
        assert [s["id"] for s in settled1] == [p1["id"]]
        assert settled1[0]["winner_option_id"] == a["id"]
        assert [o["votes"] for o in settled1[0]["options"]] == [2, 1]
        assert settled1[0]["settled_at_ms"] == 30000

        # 一次性：即使虚拟时钟继续推进 / 模拟重启后再次扫描，也不重复结算
        assert P.settle_due_polls(conn, rid, 999999, 9999.0) == []
        rows = conn.execute(
            "SELECT poll_id, COUNT(*) c FROM poll_votes GROUP BY poll_id").fetchall()
        assert {r["poll_id"]: r["c"] for r in rows} == {p1["id"]: 3, p2["id"]: 2}
        # 结果已持久化在 polls 行上
        for pid, wid in ((p1["id"], a["id"]), (p2["id"], x["id"]), (p3["id"], p_first["id"])):
            row = P.get_poll(conn, pid)
            assert row["status"] == P.POLL_SETTLED and row["winner_option_id"] == wid
        conn.close()
    print("ok: deadline boundary, plurality, tie by creation order, one-shot settlement")


def test_paused_clock_freezes_deadline():
    """暂停冻结：tick 只对 running 房间调用结算；同样的墙钟推进下，
    传入冻结虚拟毫秒时到期投票不结算，继续后才结算。"""
    with tempfile.TemporaryDirectory() as d:
        conn = open_db(os.path.join(d, "t.db"))
        # paused at 12s（init_schema 会把 running 冻结；这里直接构造 paused）
        rid = make_room(conn, status="paused", elapsed_ms=12000)
        g1, = add_groups(conn, rid, ["红"])
        poll = P.create_poll(conn, rid, 0, "30 秒截止", 30, [g1], ["A", "B"], 1000.0)
        o1, _ = P.option_rows(conn, poll["id"])
        P.cast_vote(conn, poll, g1, o1["id"], 1001.0)

        # 暂停期间无论墙钟走多久，虚拟毫秒恒为冻结值 12000：不到截止
        for frozen in (12000, 12000, 12000):
            assert P.settle_due_polls(conn, rid, frozen, time.time()) == []
        assert P.get_poll(conn, poll["id"])["status"] == P.POLL_OPEN

        # 继续后虚拟时钟到达 30s（调用方恢复 running 扫描），结算成功
        settled = P.settle_due_polls(conn, rid, 30000, time.time())
        assert [s["id"] for s in settled] == [poll["id"]]
        assert settled[0]["winner_option_id"] == o1["id"]
        conn.close()
    print("ok: pause freezes deadline countdown; resumes after resume")


def test_views_and_event_projection():
    with tempfile.TemporaryDirectory() as d:
        conn = open_db(os.path.join(d, "t.db"))
        rid = make_room(conn)
        g1, g2, g3 = add_groups(conn, rid, ["红", "蓝", "绿"])
        poll = P.create_poll(conn, rid, 0, "议题", 30, [g1, g2], ["A", "B"], 1000.0)
        pid = poll["id"]
        o1, o2 = P.option_rows(conn, pid)
        P.cast_vote(conn, poll, g1, o1["id"], 1001.0)
        P.cast_vote(conn, P.get_poll(conn, pid), g2, o2["id"], 1002.0)

        # 参与者投票中：只见自己选择，选项无 votes，无 ballots / 他组名单
        pv1 = P.player_view(conn, P.get_poll(conn, pid), g1)
        assert pv1["status"] == "open" and pv1["my_option_id"] == o1["id"]
        assert all(set(o.keys()) == {"id", "seq", "text"} for o in pv1["options"])
        assert "ballots" not in pv1 and "group_ids" not in pv1
        # 未投票参与者 my_option_id 为 None，但不暴露他组选择
        other_room_group = g3
        # g3 不在参与名单 → None（不暴露投票存在）
        assert P.player_view(conn, P.get_poll(conn, pid), g3) is None

        # 事件投影：poll_created
        hv = P.host_view(conn, P.get_poll(conn, pid))
        ev1 = P.player_event_payload("poll_created", hv, g1)
        assert ev1["id"] == pid and ev1["my_option_id"] is None
        assert all(set(o.keys()) == {"id", "seq", "text"} for o in ev1["options"])
        assert "group_ids" not in ev1 and "ballots" not in ev1
        assert P.player_event_payload("poll_created", hv, g3) is None  # 非参与组

        # poll_voted：仅本组收到，载荷无 group_id
        vote_payload = {"poll_id": pid,
                        "ballot": {"group_id": g1, "option_id": o1["id"], "updated_at": 1001.0}}
        vg1 = P.player_event_payload("poll_voted", vote_payload, g1)
        assert vg1 == {"poll_id": pid, "option_id": o1["id"], "updated_at": 1001.0}
        assert P.player_event_payload("poll_voted", vote_payload, g2) is None

        # 结算后参与者才看到票数与获胜选项，仍无逐组选票
        settled = P.settle_due_polls(conn, rid, 30000, 1030.0)[0]
        psv = P.player_view(conn, P.get_poll(conn, pid), g1)
        assert psv["status"] == "settled"
        assert sorted((o["seq"], o["votes"]) for o in psv["options"]) == [(1, 1), (2, 1)]
        assert psv["winner_option_id"] == o1["id"] and psv["settled_at_ms"] == 30000
        assert "ballots" not in psv and "group_ids" not in psv
        evs = P.player_event_payload("poll_settled", settled, g2)
        assert evs["winner_option_id"] == o1["id"]
        assert [o["votes"] for o in evs["options"]] == [1, 1]
        assert "ballots" not in evs and "group_ids" not in evs
        assert P.player_event_payload("poll_settled", settled, g3) is None

        # 主持人视图始终含完整 ballots
        assert len(settled["ballots"]) == 2
        # polls_reset：参与者投影不携带作废投票 id
        assert P.player_event_payload(
            "polls_reset", {"void_poll_ids": [pid]}, g1) == {"void_poll_ids": []}
        conn.close()
    print("ok: host/player views and per-scope event projection hide other groups")


def test_reset_voids_open_keeps_settled_by_round():
    with tempfile.TemporaryDirectory() as d:
        conn = open_db(os.path.join(d, "t.db"))
        rid = make_room(conn)
        g1, g2 = add_groups(conn, rid, ["红", "蓝"])

        settled_poll = P.create_poll(conn, rid, 0, "已结算", 5, [g1, g2], ["A", "B"], 1000.0)
        sa, _ = P.option_rows(conn, settled_poll["id"])
        P.cast_vote(conn, settled_poll, g1, sa["id"], 1001.0)
        P.settle_due_polls(conn, rid, 5000, 1005.0)

        open_poll = P.create_poll(conn, rid, 0, "未结算", 500, [g1], ["M", "N"], 1010.0)
        mo, _ = P.option_rows(conn, open_poll["id"])
        P.cast_vote(conn, open_poll, g1, mo["id"], 1011.0)  # 选票留痕

        # 重置：只有 open 的被判废；settled 原样保留（含 round=0）
        voided = P.void_open_polls(conn, rid)
        assert voided == [open_poll["id"]]
        r_open = P.get_poll(conn, open_poll["id"])
        assert r_open["status"] == P.POLL_VOID and r_open["winner_option_id"] is None
        r_settled = P.get_poll(conn, settled_poll["id"])
        assert r_settled["status"] == P.POLL_SETTLED
        assert r_settled["winner_option_id"] == sa["id"] and r_settled["round"] == 0
        # 作废投票的选票行仍在（主持人备查），但参与者视图返回 None
        assert conn.execute(
            "SELECT COUNT(*) c FROM poll_votes WHERE poll_id=?",
            (open_poll["id"],)).fetchone()["c"] == 1
        assert P.player_view(conn, r_open, g1) is None
        # 已结算历史投票也不再下发给参与者（只看本轮）
        cur = P.current_polls_for_group(conn, rid, 1, g1)
        assert cur == []
        # 主持人仍看得到全部（含作废与历史结算），顺序新轮次在前
        host = P.host_polls(conn, rid)
        assert {p["id"] for p in host} == {settled_poll["id"], open_poll["id"]}
        hv_open = next(v for v in (P.host_view(conn, p) for p in host)
                       if v["id"] == open_poll["id"])
        assert hv_open["status"] == "void" and len(hv_open["ballots"]) == 1

        # 第二轮：新投票 round=1；g1 可见，未参与的 g2 不可见；旧轮次投票不下发
        new_poll = P.create_poll(conn, rid, 1, "第二轮", 20, [g1], ["C", "D"], 2000.0)
        cur1 = P.current_polls_for_group(conn, rid, 1, g1)
        assert [p["id"] for p in cur1] == [new_poll["id"]]
        assert P.current_polls_for_group(conn, rid, 1, g2) == []
        # 第 0 轮：行级查询仍含作废投票，但快照口径（player_view）将其过滤，
        # 只保留已结算投票
        round0_rows = P.current_polls_for_group(conn, rid, 0, g1)
        assert {p["id"] for p in round0_rows} == {settled_poll["id"], open_poll["id"]}
        round0_views = [v for p in round0_rows
                        if (v := P.player_view(conn, p, g1)) is not None]
        assert [v["id"] for v in round0_views] == [settled_poll["id"]]
        assert all(v["status"] == "settled" for v in round0_views)
        assert P.player_view(conn, P.get_poll(conn, open_poll["id"]), g1) is None
        # 第二轮重置不影响第 0 轮已结算结果
        assert P.void_open_polls(conn, rid) == [new_poll["id"]]
        assert P.get_poll(conn, settled_poll["id"])["status"] == P.POLL_SETTLED
        conn.close()
    print("ok: reset voids open polls (votes retained), settled results kept by round")


def test_restart_recovers_state():
    """重连与重启恢复：投票 / 选票 / 结算结果全部持久化；
    init_schema 把停机时 running 房间安全冻结为 paused，已流逝时间入账，
    截止计时在暂停期间不偷偷前进。"""
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "t.db")
        conn = open_db(path)
        now = time.time()
        rid = conn.execute(
            "INSERT INTO rooms (code,name,status,elapsed_ms,last_resume_at,created_at)"
            " VALUES ('RST001','重启','running',0,?,?)", (now, now)).lastrowid
        conn.commit()
        g1 = conn.execute(
            "INSERT INTO groups (room_id,name,join_code,created_at) VALUES (?,?,?,?)",
            (rid, "红", "RRR001", now)).lastrowid
        conn.commit()
        poll = P.create_poll(conn, rid, 0, "跨重启", 30, [g1], ["A", "B"], now)
        o1, _ = P.option_rows(conn, poll["id"])
        P.cast_vote(conn, poll, g1, o1["id"], now + 1)
        conn.close()

        # 模拟重启：重新 init_schema（running → paused，结算本运行段墙钟流逝）
        conn2 = open_db(path)
        room = conn2.execute("SELECT * FROM rooms WHERE id=?", (rid,)).fetchone()
        assert room["status"] == "paused"
        assert room["elapsed_ms"] >= 0 and room["last_resume_at"] is None
        # 选票仍在；暂停状态下 tick 不会结算（冻结虚拟时间）
        row = conn2.execute(
            "SELECT option_id FROM poll_votes WHERE poll_id=? AND group_id=?",
            (poll["id"], g1)).fetchone()
        assert row["option_id"] == o1["id"]
        frozen = room["elapsed_ms"]
        assert P.settle_due_polls(conn2, rid, frozen, time.time()) == []
        pv = P.player_view(conn2, P.get_poll(conn2, poll["id"]), g1)
        assert pv["status"] == "open" and pv["my_option_id"] == o1["id"]
        conn2.close()
    print("ok: restart recovers votes/options, running room safely paused, no early settle")


def test_legacy_db_migration_adds_poll_tables():
    """旧库（最早版本，无任何投票表）走启动迁移后投票四表可用，旧数据不丢。"""
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "old.db")
        legacy = sqlite3.connect(path)
        legacy.row_factory = sqlite3.Row
        legacy.executescript("""
        CREATE TABLE rooms (
            id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'idle',
            elapsed_ms INTEGER NOT NULL DEFAULT 0, last_resume_at REAL, created_at REAL NOT NULL);
        CREATE TABLE groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL,
            name TEXT NOT NULL, join_code TEXT NOT NULL UNIQUE, created_at REAL NOT NULL);
        CREATE TABLE cards (
            id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL,
            seq INTEGER NOT NULL, trigger_seconds INTEGER NOT NULL,
            title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '');
        CREATE TABLE events (
            id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL,
            type TEXT NOT NULL, payload TEXT NOT NULL, created_at REAL NOT NULL);
        """)
        legacy.execute(
            "INSERT INTO rooms (code,name,status,created_at) VALUES ('OLD002','旧','idle',1.0)")
        legacy.execute(
            "INSERT INTO groups (room_id,name,join_code,created_at) VALUES (1,'老组','OLD111',1.0)")
        legacy.commit()
        legacy.close()

        conn = open_db(path)  # 内部走 dbmod.init_schema（= 启动迁移路径）
        names = {r["name"] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        assert {"polls", "poll_options", "poll_participants", "poll_votes"} <= names
        # 旧房间 / 旧组仍在，且可在旧组上直接发起投票
        gid = conn.execute("SELECT id FROM groups WHERE join_code='OLD111'").fetchone()["id"]
        poll = P.create_poll(conn, 1, 0, "迁移后投票", 60, [gid], ["选项一", "选项二"], 2.0)
        opts = P.option_rows(conn, poll["id"])
        P.cast_vote(conn, poll, gid, opts[0]["id"], 2.0)
        settled = P.settle_due_polls(conn, 1, 60000, 62.0)
        assert settled[0]["winner_option_id"] == opts[0]["id"]
        conn.close()
    print("ok: legacy db migration adds polls/poll_options/poll_participants/poll_votes")


def test_poll_events_outside_export_whitelist():
    """投票事件不进复盘包白名单（本模块不导出投票明细）。"""
    from app import export as rv
    for t in P.POLL_EVENT_TYPES:
        assert t not in rv._EXPORTED_TYPES, t
    print("ok: poll event types excluded from review export whitelist")


if __name__ == "__main__":
    test_create_and_one_vote_per_group()
    test_deadline_and_one_shot_settlement()
    test_paused_clock_freezes_deadline()
    test_views_and_event_projection()
    test_reset_voids_open_keeps_settled_by_round()
    test_restart_recovers_state()
    test_legacy_db_migration_adds_poll_tables()
    test_poll_events_outside_export_whitelist()
    print("ALL POLL TESTS PASSED")
