#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Build public, scoreboard-only JSON files from DOMjudge exports."""

from __future__ import annotations

import argparse
import json
import re
import unicodedata
from datetime import datetime
from pathlib import Path


SITE_DIR = Path(__file__).resolve().parent.parent / "docs"
DEFAULT_OUTPUT_DIR = SITE_DIR / "data"
MANIFEST_FILENAME = "contests.manifest.json"


def read_json(path: Path):
    with path.open(encoding="utf-8") as source:
        return json.load(source)


def timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError(f"Timezone is missing: {value}")
    return parsed


def offset_ms(value: str, start: datetime) -> int:
    return round((timestamp(value) - start).total_seconds() * 1000)


def duration_ms(value: str) -> int:
    match = re.fullmatch(r"(\d+):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?", value)
    if not match:
        raise ValueError(f"Invalid duration: {value}")
    hours, minutes, seconds, fraction = match.groups()
    return (
        (int(hours) * 3600 + int(minutes) * 60 + int(seconds)) * 1000
        + int((fraction or "0").ljust(3, "0"))
    )


def read_event_feed(path: Path) -> dict:
    """Fold event updates into the latest visible object for each type and ID."""
    contest = None
    state = None
    objects = {
        "judgement-types": {},
        "teams": {},
        "problems": {},
        "submissions": {},
        "judgements": {},
    }
    with path.open(encoding="utf-8") as source:
        for line in source:
            if not line.strip():
                continue
            event = json.loads(line)
            event_type = event["type"]
            if event_type == "contest":
                contest = event.get("data")
            elif event_type == "state":
                state = event.get("data")
            elif event_type in objects:
                event_id = event.get("id")
                if event_id is None:
                    raise ValueError(f"event-feed.ndjson の {event_type} に ID がありません")
                if event.get("data") is None or event.get("op") == "delete":
                    objects[event_type].pop(event_id, None)
                else:
                    objects[event_type][event_id] = event["data"]
    if contest is None or not objects["judgement-types"]:
        raise ValueError("event-feed.ndjson に contest または judgement-types がありません")
    return {"contest": contest, "state": state, **objects}


def read_snapshot_export(source_dir: Path, contest_path: Path) -> dict:
    """Read the same final objects from API snapshots when the feed is absent."""
    contest = read_json(contest_path)
    required_contest_fields = {
        "name", "scoreboard_type", "start_time", "end_time",
        "penalty_time", "scoreboard_freeze_duration",
    }
    if (not isinstance(contest, dict)
            or not required_contest_fields <= contest.keys()
            or not isinstance(contest["name"], str) or not contest["name"].strip()
            or not isinstance(contest["penalty_time"], int) or isinstance(contest["penalty_time"], bool)
            or contest["penalty_time"] < 0):
        raise ValueError("contest の大会名・採点方式・ペナルティ時間・凍結設定が正しくありません")
    timestamp(contest["start_time"])
    timestamp(contest["end_time"])
    freeze_duration = contest["scoreboard_freeze_duration"]
    if freeze_duration is not None:
        duration_ms(freeze_duration)
    type_records = read_json(source_dir / "judgement-types.json")
    if (not isinstance(type_records, list) or not type_records
            or any(not isinstance(record, dict)
                   or not isinstance(record.get("id"), str) or not record["id"]
                   or not isinstance(record.get("solved"), bool)
                   or not isinstance(record.get("penalty"), bool)
                   for record in type_records)):
        raise ValueError("judgement-types.json の形式が正しくありません")
    judgement_types = {record["id"]: record for record in type_records}
    if len(judgement_types) != len(type_records):
        raise ValueError("judgement-types.json に重複する ID があります")

    state = read_json(source_dir / "scoreboard.json").get("state")
    if not isinstance(state, dict) or not state.get("started") or not state.get("ended"):
        raise ValueError("scoreboard.json に開始・終了時刻がありません")
    objects = {}
    for name in ("teams", "problems", "submissions", "judgements"):
        records = read_json(source_dir / f"{name}.json")
        if not isinstance(records, list):
            raise ValueError(f"{name}.json は配列である必要があります")
        if any(not isinstance(record, dict) or not isinstance(record.get("id"), str)
               or not record["id"] for record in records):
            raise ValueError(f"{name}.json に ID のない項目があります")
        by_id = {record["id"]: record for record in records}
        if len(by_id) != len(records):
            raise ValueError(f"{name}.json に重複する ID があります")
        objects[name] = by_id
    return {"contest": contest, "state": state, "judgement-types": judgement_types, **objects}


def is_unused_account(team: dict, submitted_team_ids: set[str]) -> bool:
    """Exclude accounts with no submissions and no customized display name."""
    if team["id"] in submitted_team_ids:
        return False
    display_name = (team.get("display_name") or "").strip()
    name = (team.get("name") or "").strip()
    return not display_name or display_name == name == team["id"]


def build_replay_data(
    source_dir: Path,
    contest_path: Path | None = None,
) -> dict:
    feed_path = source_dir / "event-feed.ndjson"
    feed = (read_snapshot_export(source_dir, contest_path or source_dir / "contest.json")
            if contest_path or not feed_path.is_file() else read_event_feed(feed_path))
    contest = feed["contest"]
    judgement_types = feed["judgement-types"]
    if contest.get("scoreboard_type") != "pass-fail":
        raise ValueError("This viewer only supports pass-fail scoreboards")
    scoreboard = read_json(source_dir / "scoreboard.json")
    state = feed["state"] or scoreboard.get("state") or {}
    start_value = state.get("started") or contest["start_time"]
    end_value = state.get("ended") or contest["end_time"]
    start = timestamp(start_value)
    contest_duration_ms = offset_ms(end_value, start)
    if contest_duration_ms <= 0:
        raise ValueError("Contest end must be after start")

    freeze_value = state.get("frozen")
    if freeze_value:
        freeze_ms = offset_ms(freeze_value, start)
    elif contest.get("scoreboard_freeze_duration"):
        freeze_ms = contest_duration_ms - duration_ms(contest["scoreboard_freeze_duration"])
    else:
        freeze_ms = None
    if freeze_ms is not None and not 0 <= freeze_ms <= contest_duration_ms:
        raise ValueError("Freeze time is outside the contest")

    scoreboard_team_ids = {row["team_id"] for row in scoreboard["rows"]}
    original_teams = list(feed["teams"].values())
    # DOMjudge lists teams by numeric teamid, while the feed can introduce
    # older teams in a different order.
    if all(str(team.get("teamid", "")).isdigit() for team in original_teams):
        original_teams.sort(key=lambda team: int(team["teamid"]))
    submissions = list(feed["submissions"].values())
    submitted_team_ids = {submission["team_id"] for submission in submissions}
    selected_teams = [
        team for team in original_teams
        if team["id"] in scoreboard_team_ids and not team.get("hidden", False)
    ]
    if len(selected_teams) != len(scoreboard_team_ids):
        raise ValueError("scoreboard.json のチームを event-feed.ndjson で確認できません")
    selected_teams = [
        team for team in selected_teams
        if not is_unused_account(team, submitted_team_ids)
    ]
    team_index = {team["id"]: index for index, team in enumerate(selected_teams)}
    teams = [
        [
            (team.get("display_name") or team.get("name") or team["id"]).strip(),
            team.get("affiliation") or "",
        ]
        for team in selected_teams
    ]

    original_problems = sorted(
        feed["problems"].values(),
        key=lambda problem: int(problem.get("ordinal") or 0),
    )
    problem_index = {problem["id"]: index for index, problem in enumerate(original_problems)}
    problems = [
        [problem["label"], problem["name"], problem.get("rgb") or "#999999"]
        for problem in original_problems
    ]

    latest_judgements = {}
    for judgement in feed["judgements"].values():
        if not judgement.get("valid"):
            continue
        submission_id = judgement["submission_id"]
        previous = latest_judgements.get(submission_id)
        if previous is None or int(judgement["id"]) > int(previous["id"]):
            latest_judgements[submission_id] = judgement

    attempts_with_order = []
    for submission in submissions:
        if submission["team_id"] not in team_index:
            continue
        submitted_ms = offset_ms(submission["time"], start)
        if not 0 <= submitted_ms < contest_duration_ms:
            continue
        if submission["problem_id"] not in problem_index:
            raise ValueError(f"Unknown problem for submission {submission['id']}")
        judgement = latest_judgements.get(submission["id"])
        if not judgement or not judgement.get("end_time"):
            raise ValueError(f"競技中の提出 {submission['id']} に完了済みの有効な判定がありません")
        judged_ms = offset_ms(judgement["end_time"], start)
        if judged_ms < submitted_ms:
            raise ValueError(f"Judgement ended before submission {submission['id']}")
        judgement_type_id = judgement.get("judgement_type_id")
        if judgement_type_id not in judgement_types:
            raise ValueError(f"Unknown judgement type for submission {submission['id']}")
        judgement_type = judgement_types[judgement_type_id]
        result = 2 if judgement_type["solved"] else 1 if judgement_type["penalty"] else 0
        # Public format: [team index, problem index, submitted ms, judged ms,
        # result]. Result is 0=non-penalty, 1=penalty, 2=solved.
        attempt = [
            team_index[submission["team_id"]],
            problem_index[submission["problem_id"]],
            submitted_ms,
            judged_ms,
            result,
        ]
        attempts_with_order.append((submitted_ms, int(submission["id"]), attempt))

    attempts_with_order.sort(key=lambda item: (item[0], item[1]))
    return {
        "contest": {
            "name": contest.get("formal_name") or contest["name"],
            "start": start_value,
            "duration_ms": contest_duration_ms,
            "freeze_ms": freeze_ms,
            "penalty_minutes": int(contest.get("penalty_time", 20)),
        },
        "teams": teams,
        "problems": problems,
        "attempts": [item[2] for item in attempts_with_order],
    }


def valid_contest_id(value: str) -> bool:
    return bool(value) and value == value.casefold() and all(
        part.isalnum() for part in value.split("-")
    )


def slugify_contest_name(name: str) -> str:
    normalized = unicodedata.normalize("NFKC", name).casefold()
    slug = re.sub(r"-+", "-", "".join(
        character if character.isalnum() else "-" for character in normalized
    )).strip("-")
    if not valid_contest_id(slug):
        raise ValueError(f"大会名から有効な ID を生成できません: {name!r}")
    return slug


def contest_argument(value: str) -> tuple[str | None, Path]:
    if "=" not in value:
        return None, Path(value)
    contest_id, source_dir = value.split("=", 1)
    if not valid_contest_id(contest_id) or not source_dir:
        raise argparse.ArgumentTypeError("--contest は ディレクトリ または ID=ディレクトリ の形式で指定してください")
    return contest_id, Path(source_dir)


def write_json(path: Path, value: dict) -> None:
    with path.open("w", encoding="utf-8") as destination:
        json.dump(value, destination, ensure_ascii=False, separators=(",", ":"))
        destination.write("\n")


def existing_contests(output_dir: Path) -> dict[str, dict]:
    """Keep published contests when only one new contest is generated."""
    manifest = output_dir / MANIFEST_FILENAME
    if not manifest.is_file():
        return {}
    contents = read_json(manifest)
    contests = contents.get("contests") if isinstance(contents, dict) else None
    if not isinstance(contests, list):
        raise ValueError(f"{MANIFEST_FILENAME} の形式が正しくありません")
    existing = {}
    for contest in contests:
        if not isinstance(contest, dict):
            raise ValueError(f"{MANIFEST_FILENAME} の形式が正しくありません")
        contest_id = contest.get("id")
        filename = contest.get("file")
        if (not isinstance(contest_id, str)
                or not valid_contest_id(contest_id)
                or filename != f"{contest_id}.json"
                or not isinstance(contest.get("name"), str)
                or contest_id in existing):
            raise ValueError(f"{MANIFEST_FILENAME} の大会情報が正しくありません")
        if (output_dir / filename).is_file():
            existing[contest_id] = contest
    return existing


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--contest", type=contest_argument, action="append", required=True,
        metavar="[ID=]DIR",
        help="追加または再生成する大会のエクスポートディレクトリ（複数指定可）。ID は既定で大会名から生成します",
    )
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument(
        "--contest-json", type=Path,
        help="contest エンドポイントの JSON（通常は DIR/contest.json を自動で使用）",
    )
    args = parser.parse_args()
    if args.contest_json and len(args.contest) != 1:
        parser.error("--contest-json を使う場合は --contest を1回だけ指定してください")

    # Build first so a contest ID can be derived from the actual contest name.
    replay_data = []
    for requested_id, source_dir in args.contest:
        data = build_replay_data(source_dir, args.contest_json)
        contest_id = requested_id or slugify_contest_name(data["contest"]["name"])
        replay_data.append((contest_id, data))
    ids = [contest_id for contest_id, _ in replay_data]
    if len(ids) != len(set(ids)):
        parser.error("大会 ID が重複しています")

    # Validate existing files before updating the published data.
    contests = existing_contests(args.output_dir)
    for contest_id, data in replay_data:
        output = args.output_dir / f"{contest_id}.json"
        if output.is_file():
            previous = read_json(output)["contest"]
            current = data["contest"]
            if (previous["name"], previous["start"]) != (current["name"], current["start"]):
                parser.error(f"大会 ID {contest_id} は別のコンテストに使用されています")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for contest_id, data in replay_data:
        filename = f"{contest_id}.json"
        output = args.output_dir / filename
        write_json(output, data)
        contests[contest_id] = {"id": contest_id, "name": data["contest"]["name"], "file": filename}
        print(f"{output}: {len(data['teams'])} teams, {len(data['problems'])} problems, {len(data['attempts'])} attempts")
    manifest = args.output_dir / MANIFEST_FILENAME
    ordered_contests = sorted(
        contests.values(),
        key=lambda contest: (
            timestamp(read_json(args.output_dir / contest["file"])["contest"]["start"]),
            contest["id"],
        ),
        reverse=True,
    )
    write_json(manifest, {"contests": ordered_contests})
    print(f"{manifest}: {len(contests)} contests")


if __name__ == "__main__":
    main()
