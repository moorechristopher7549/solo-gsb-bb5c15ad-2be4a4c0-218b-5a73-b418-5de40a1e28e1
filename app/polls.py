"""现场决策投票 —— 纯存储 / 结算 / 视野逻辑（不依赖 FastAPI）。

main.py 负责 REST、WebSocket、广播投影与 state_lock；本模块只读写传入的
SQLite 连接，因此后台 tick、REST 路由与无第三方依赖的测试走的是同一份代码。

语义（与产品口径一一对应）：
- 主持人创建投票：2～4 个选项、指定参与组、截止虚拟秒；创建时绑定当前轮次。
- 仅指定组在「截止前」可提交或改投：每组只计一票（UNIQUE(poll_id, group_id)，
  改投 = UPDATE 同一行），截止判定走虚拟时钟（暂停冻结由调用方保证：
  ticker 只扫描 running 房间）。
- 到期一次性结算：status 翻为 settled 后 settle_due_polls 不会再选中它，
  天然只结算一次；最高票获胜，平票按选项创建顺序（seq, id）决定；
  全员弃权（0 票）时第一个选项获胜，结果同样持久化。
- 重置：当前轮未结算投票整批判废（status=void，选票留痕备查），
  已结算结果按轮次保留（行内 round 归属原轮次）。
- 视野：主持人看逐组选票与汇总；参与者只见自己的选择，结算后才看到结果；
  观察者完全不可见（main 的快照 / 事件投影负责）。
"""

from __future__ import annotations

import logging
import sqlite3
import time

log = logging.getLogger("inject")

POLL_OPEN = "open"          # 投票中（截止虚拟秒未到）
POLL_SETTLED = "settled"    # 已一次性结算（结果持久化，跨重置保留）
POLL_VOID = "void"          # 重置时未结算，已作废

# 投票类事件集合：观察者一律不可见（main 的事件投影按此前缀过滤）。
# polls_reset 随房间级 reset 同时下发：主持人据此把未结算投票翻成「已作废」，
# 参与者据此清空本轮投票视图。
POLL_EVENT_TYPES = frozenset(
    {"poll_created", "poll_voted", "poll_settled", "polls_reset"}
)

MIN_OPTIONS = 2
MAX_OPTIONS = 4


# ---------------------------------------------------------------- 读取

def get_poll(conn: sqlite3.Connection, poll_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM polls WHERE id = ?", (poll_id,)).fetchone()


def option_rows(conn: sqlite3.Connection, poll_id: int) -> list[sqlite3.Row]:
    """选项按创建顺序（seq, id）升序——平票决胜与该顺序一致。"""
    return conn.execute(
        "SELECT * FROM poll_options WHERE poll_id = ? ORDER BY seq, id", (poll_id,)
    ).fetchall()


def vote_rows(conn: sqlite3.Connection, poll_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM poll_votes WHERE poll_id = ? ORDER BY group_id", (poll_id,)
    ).fetchall()


def participant_ids(conn: sqlite3.Connection, poll_id: int) -> list[int]:
    return [r["group_id"] for r in conn.execute(
        "SELECT group_id FROM poll_participants WHERE poll_id = ? ORDER BY group_id",
        (poll_id,),
    )]


def is_participant(conn: sqlite3.Connection, poll_id: int, group_id: int) -> bool:
    return conn.execute(
        "SELECT 1 FROM poll_participants WHERE poll_id = ? AND group_id = ?",
        (poll_id, group_id),
    ).fetchone() is not None


def host_polls(conn: sqlite3.Connection, room_id: int) -> list[sqlite3.Row]:
    """主持人看全部轮次的全部投票：新轮次在前、同轮次新创建在前。"""
    return conn.execute(
        "SELECT * FROM polls WHERE room_id = ? ORDER BY round DESC, id DESC",
        (room_id,),
    ).fetchall()


def current_polls_for_group(
    conn: sqlite3.Connection, room_id: int, round_idx: int, group_id: int
) -> list[sqlite3.Row]:
    """参与者只拿本轮、且本组在参与名单内的投票（旧轮次投票不可见）。"""
    return conn.execute(
        """SELECT p.* FROM polls p
           JOIN poll_participants pp ON pp.poll_id = p.id
           WHERE p.room_id = ? AND p.round = ? AND pp.group_id = ?
           ORDER BY p.id DESC""",
        (room_id, round_idx, group_id),
    ).fetchall()


# ---------------------------------------------------------------- 写入

def create_poll(
    conn: sqlite3.Connection,
    room_id: int,
    round_idx: int,
    title: str,
    deadline_seconds: int,
    group_ids: list[int],
    option_texts: list[str],
    now: float,
) -> sqlite3.Row:
    """创建投票并落库选项 / 参与组。调用方负责参数校验（2~4 项、组属于本房间）。"""
    cur = conn.execute(
        "INSERT INTO polls (room_id, round, title, deadline_seconds, status, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (room_id, round_idx, title, deadline_seconds, POLL_OPEN, now),
    )
    poll_id = cur.lastrowid
    for seq, text in enumerate(option_texts, start=1):
        conn.execute(
            "INSERT INTO poll_options (poll_id, seq, text) VALUES (?, ?, ?)",
            (poll_id, seq, text),
        )
    for gid in group_ids:
        conn.execute(
            "INSERT INTO poll_participants (poll_id, group_id) VALUES (?, ?)",
            (poll_id, gid),
        )
    conn.commit()
    return get_poll(conn, poll_id)


def cast_vote(
    conn: sqlite3.Connection, poll: sqlite3.Row, group_id: int, option_id: int, now: float
) -> sqlite3.Row:
    """提交 / 改投：每组只保留一行（UNIQUE(poll_id, group_id)），改投即 UPDATE。"""
    existing = conn.execute(
        "SELECT * FROM poll_votes WHERE poll_id = ? AND group_id = ?",
        (poll["id"], group_id),
    ).fetchone()
    if existing is None:
        conn.execute(
            "INSERT INTO poll_votes (room_id, poll_id, group_id, option_id, updated_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (poll["room_id"], poll["id"], group_id, option_id, now),
        )
    else:
        conn.execute(
            "UPDATE poll_votes SET option_id = ?, updated_at = ? WHERE id = ?",
            (option_id, now, existing["id"]),
        )
    conn.commit()
    return conn.execute(
        "SELECT * FROM poll_votes WHERE poll_id = ? AND group_id = ?",
        (poll["id"], group_id),
    ).fetchone()


def void_open_polls(conn: sqlite3.Connection, room_id: int) -> list[int]:
    """重置演练：把房间内所有未结算投票判废（选票行留痕，结果表 winner 保持 NULL）。

    已结算 / 已作废的投票不受影响——已结算结果按轮次保留；返回作废投票 id
    列表供调用方广播 polls_reset（主持人就地翻转状态、参与者清空本轮视图）。
    """
    due = conn.execute(
        "SELECT id FROM polls WHERE room_id = ? AND status = ? ORDER BY id",
        (room_id, POLL_OPEN),
    ).fetchall()
    ids = [r["id"] for r in due]
    if ids:
        marks = ",".join("?" * len(ids))
        conn.execute(
            f"UPDATE polls SET status = ? WHERE id IN ({marks})",
            (POLL_VOID, *ids),
        )
        conn.commit()
    return ids


def settle_due_polls(
    conn: sqlite3.Connection, room_id: int, elapsed_ms: int, now: float
) -> list[dict]:
    """在锁内结算所有「已到截止虚拟秒」的投票，返回各投票的主持人视图。

    一次性：先按 status='open' 选中，结算 UPDATE 把状态翻为 settled 并提交，
    之后任何 tick / 重启都不会再次选中同一投票。平票按选项创建顺序决定，
    结果（winner_option_id, settled_at_ms）持久化，重启后直接读取不再重算。
    调用方（ticker）只对 running 房间调用本函数——暂停期间 elapsed 冻结，
    截止计时随之冻结。
    """
    due = conn.execute(
        "SELECT * FROM polls"
        " WHERE room_id = ? AND status = ? AND deadline_seconds * 1000 <= ? ORDER BY id",
        (room_id, POLL_OPEN, elapsed_ms),
    ).fetchall()
    settled_views: list[dict] = []
    for poll in due:
        options = option_rows(conn, poll["id"])
        counts = {o["id"]: 0 for o in options}
        for v in vote_rows(conn, poll["id"]):
            if v["option_id"] in counts:
                counts[v["option_id"]] += 1
        # 稳定决胜：严格大于才替换 → 平票时保留创建顺序更靠前的选项；0 票时为首项。
        winner = options[0]
        for opt in options[1:]:
            if counts[opt["id"]] > counts[winner["id"]]:
                winner = opt
        conn.execute(
            "UPDATE polls SET status = ?, winner_option_id = ?, settled_at_ms = ? WHERE id = ?",
            (POLL_SETTLED, winner["id"], elapsed_ms, poll["id"]),
        )
        conn.commit()
        log.info("poll %s settled at vtime=%sms winner_option=%s counts=%s",
                 poll["id"], elapsed_ms, winner["id"], dict(counts))
        fresh = get_poll(conn, poll["id"])
        settled_views.append(host_view(conn, fresh))
    return settled_views


# ---------------------------------------------------------------- 视野序列化

def _counts(conn: sqlite3.Connection, poll_id: int,
            options: list[sqlite3.Row]) -> dict[int, int]:
    counts = {o["id"]: 0 for o in options}
    for v in vote_rows(conn, poll_id):
        if v["option_id"] in counts:
            counts[v["option_id"]] += 1
    return counts


def host_view(conn: sqlite3.Connection, poll: sqlite3.Row) -> dict:
    """主持人视图：参与组、逐组选票（ballots）、每选项票数与获胜选项。"""
    options = option_rows(conn, poll["id"])
    counts = _counts(conn, poll["id"], options)
    return {
        "id": poll["id"],
        "round": poll["round"],
        "title": poll["title"],
        "deadline_seconds": poll["deadline_seconds"],
        "status": poll["status"],
        "group_ids": participant_ids(conn, poll["id"]),
        "options": [
            {"id": o["id"], "seq": o["seq"], "text": o["text"], "votes": counts[o["id"]]}
            for o in options
        ],
        # 逐组实时选票：改投只保留最新选项；作废投票留冻结时刻的选票备查
        "ballots": [
            {"group_id": v["group_id"], "option_id": v["option_id"],
             "updated_at": v["updated_at"]}
            for v in vote_rows(conn, poll["id"])
        ],
        "winner_option_id": poll["winner_option_id"],
        "settled_at_ms": poll["settled_at_ms"],
    }


def player_view(conn: sqlite3.Connection, poll: sqlite3.Row, group_id: int) -> dict | None:
    """参与者视图：非本组投票 / 已作废投票返回 None（不下发）。

    投票中只见选项文本与本组选择（my_option_id），看不到任何票数与他组选票；
    结算后才看到每选项票数、获胜选项与结算虚拟时间（仍无逐组选票）。
    """
    if poll["status"] == POLL_VOID or not is_participant(conn, poll["id"], group_id):
        return None
    options = option_rows(conn, poll["id"])
    data = {
        "id": poll["id"],
        "round": poll["round"],
        "title": poll["title"],
        "deadline_seconds": poll["deadline_seconds"],
        "status": poll["status"],
    }
    mine = conn.execute(
        "SELECT option_id FROM poll_votes WHERE poll_id = ? AND group_id = ?",
        (poll["id"], group_id),
    ).fetchone()
    if poll["status"] == POLL_SETTLED:
        counts = _counts(conn, poll["id"], options)
        data["options"] = [
            {"id": o["id"], "seq": o["seq"], "text": o["text"], "votes": counts[o["id"]]}
            for o in options
        ]
        data["winner_option_id"] = poll["winner_option_id"]
        data["settled_at_ms"] = poll["settled_at_ms"]
        # 结算后顺带告知本组的最终选择（仍不暴露他组选票）
        data["my_option_id"] = mine["option_id"] if mine else None
    else:
        data["options"] = [
            {"id": o["id"], "seq": o["seq"], "text": o["text"]} for o in options
        ]
        data["my_option_id"] = mine["option_id"] if mine else None
        data["winner_option_id"] = None
        data["settled_at_ms"] = None
    return data


# ---------------------------------------------------------------- 事件投影（纯字典）

def player_event_payload(type_: str, payload: dict, group_id: int) -> dict | None:
    """投票事件的参与者版载荷（纯字典推导，无需数据库）。

    - poll_created：仅参与组收到；只有选项文本，无票数 / 无他组名单；
    - poll_voted：仅本组收到（同组多窗口同步），载荷不带 group_id；
    - poll_settled：仅参与组收到，附每选项票数与获胜选项，无逐组选票；
    - polls_reset：房间级（随 reset 下发），参与者清空本轮投票，
      不携带任何投票明细。
    """
    if type_ == "poll_created":
        if group_id not in payload.get("group_ids", []):
            return None
        return {
            "id": payload["id"],
            "round": payload["round"],
            "title": payload["title"],
            "deadline_seconds": payload["deadline_seconds"],
            "status": POLL_OPEN,
            "options": [
                {"id": o["id"], "seq": o["seq"], "text": o["text"]}
                for o in payload.get("options", [])
            ],
            "my_option_id": None,
            "winner_option_id": None,
            "settled_at_ms": None,
        }
    if type_ == "poll_voted":
        ballot = payload.get("ballot") or {}
        if ballot.get("group_id") != group_id:
            return None
        return {
            "poll_id": payload["poll_id"],
            "option_id": ballot.get("option_id"),
            "updated_at": ballot.get("updated_at"),
        }
    if type_ == "poll_settled":
        if group_id not in payload.get("group_ids", []):
            return None
        return {
            "id": payload["id"],
            "round": payload["round"],
            "title": payload["title"],
            "deadline_seconds": payload["deadline_seconds"],
            "status": POLL_SETTLED,
            "options": [
                {"id": o["id"], "seq": o["seq"], "text": o["text"],
                 "votes": o.get("votes", 0)}
                for o in payload.get("options", [])
            ],
            "winner_option_id": payload.get("winner_option_id"),
            "settled_at_ms": payload.get("settled_at_ms"),
        }
    if type_ == "polls_reset":
        # 房间级：参与者只需要知道「本轮投票已清空」，不携带作废投票明细
        return {"void_poll_ids": []}
    return None
