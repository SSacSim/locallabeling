#!/usr/bin/env python3
"""FastAPI image labeling prototype with login, projects, and YOLO folders."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import threading
import uuid
from datetime import datetime, timedelta, timezone
from email.utils import formatdate, parsedate_to_datetime
from pathlib import Path, PurePosixPath
from typing import Optional
from urllib.parse import quote

import uvicorn
from fastapi import Depends, FastAPI, Header, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
STATE_PATH = DATA_DIR / "app_state.json"
STATIC_DIR = BASE_DIR / "static"
DEFAULT_YOLO_ROOT = DATA_DIR / "yolo"

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
DEFAULT_LABELS = ["positive", "negative", "uncertain"]
DEFAULT_LABEL_COLORS = [
    "#1f77b4",
    "#ff7f0e",
    "#2ca02c",
    "#d62728",
    "#9467bd",
    "#8c564b",
    "#e377c2",
    "#7f7f7f",
    "#bcbd22",
    "#17becf",
    "#393b79",
    "#637939",
]
CLAIM_TTL_SECONDS = int(os.environ.get("CLAIM_TTL_SECONDS", "1800"))
IMAGE_CACHE_SECONDS = int(os.environ.get("IMAGE_CACHE_SECONDS", "86400"))

STATE_LOCK = threading.Lock()
SESSIONS: dict[str, dict] = {}
CLAIMS: dict[str, dict] = {}
CLAIM_COUNTS = {"released": 0, "completed": 0, "expired": 0}


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


class LoginPayload(BaseModel):
    username: str
    password: str


class UserCreatePayload(BaseModel):
    username: str
    password: str
    role: str = "worker"


class UserActivePayload(BaseModel):
    username: str
    active: bool


class UserRemovePayload(BaseModel):
    username: str


class ProjectCreatePayload(BaseModel):
    name: str
    labels: list[str | dict] = []


class ProjectRemovePayload(BaseModel):
    project_id: str


class ProjectUpdatePayload(BaseModel):
    project_id: str
    name: str
    labels: list[str | dict]


class ProjectLabelsPayload(BaseModel):
    project_id: str
    labels: list[str | dict]


class YoloFolderPayload(BaseModel):
    project_id: str
    path: str


class FolderRemovePayload(BaseModel):
    project_id: str
    folder_id: str


class AssignmentPayload(BaseModel):
    username: str
    project_id: str
    folder_id: str


class AssignmentBulkPayload(BaseModel):
    username: str
    project_id: str
    folder_ids: list[str]


class ClaimPayload(BaseModel):
    project_id: Optional[str] = None
    folder_id: Optional[str] = None


class FolderMarkPayload(BaseModel):
    project_id: str
    folder_id: str
    status: str


class WorkerCheckpointPayload(BaseModel):
    image_id: str


class LabelPayload(BaseModel):
    image_id: str
    claim_id: str
    label_id: int
    notes: Optional[str] = ""


class AnnotationBox(BaseModel):
    label_id: int
    x: float
    y: float
    width: float
    height: float


class AnnotationSavePayload(BaseModel):
    image_id: str
    claim_id: Optional[str] = ""
    annotations: list[AnnotationBox] = []


class ReleasePayload(BaseModel):
    claim_id: str


app = FastAPI(title="이미지 라벨링 프로토타입", version="0.7.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def utc_iso(value: datetime | None = None) -> str:
    value = value or utc_now()
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_utc(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def ensure_storage() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    DEFAULT_YOLO_ROOT.mkdir(parents=True, exist_ok=True)
    if not STATE_PATH.exists():
        write_state(default_state())


def default_state() -> dict:
    return {
        "version": 2,
        "users": {
            "admin": {
                "username": "admin",
                "role": "admin",
                **hash_password("admin"),
                "active": True,
                "created_at": utc_iso(),
            }
        },
        "projects": [],
    }


def load_state() -> dict:
    ensure_storage_dirs_only()
    if not STATE_PATH.exists():
        state = default_state()
        write_state(state)
        return state
    try:
        raw = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ApiError(500, "invalid_state", "앱 설정 파일을 읽을 수 없습니다.") from exc
    return normalize_state(raw)


def write_state(state: dict) -> None:
    ensure_storage_dirs_only()
    tmp_path = STATE_PATH.with_name(f".{STATE_PATH.name}.{uuid.uuid4().hex}.tmp")
    tmp_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")
    os.replace(tmp_path, STATE_PATH)


def ensure_storage_dirs_only() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    DEFAULT_YOLO_ROOT.mkdir(parents=True, exist_ok=True)


def normalize_state(state: dict) -> dict:
    if not isinstance(state, dict):
        state = {}
    users = state.get("users")
    projects = state.get("projects")
    if not isinstance(users, dict) or "admin" not in users:
        users = default_state()["users"]
    users = normalize_users(users)
    if not isinstance(projects, list):
        projects = []

    normalized_projects = []
    seen_projects = set()
    for project in projects:
        if not isinstance(project, dict):
            continue
        project_id = str(project.get("id") or "").strip()
        name = str(project.get("name") or "").strip()
        if not project_id or not name or project_id in seen_projects:
            continue
        seen_projects.add(project_id)
        labels = normalize_labels(project.get("labels") or DEFAULT_LABELS)
        folders = normalize_project_folders(project.get("folders"))
        assignments = normalize_project_assignments(project.get("assignments"), users, {f["id"] for f in folders})
        folder_marks = normalize_project_folder_marks(project.get("folder_marks"), users, {f["id"] for f in folders})
        folder_checkpoints = normalize_project_folder_checkpoints(
            project.get("folder_checkpoints"), users, {f["id"] for f in folders}
        )
        normalized_projects.append(
            {
                "id": project_id,
                "name": name,
                "labels": labels,
                "folders": folders,
                "assignments": assignments,
                "folder_marks": folder_marks,
                "folder_checkpoints": folder_checkpoints,
                "created_at": str(project.get("created_at") or utc_iso()),
            }
        )

    return {"version": 2, "users": users, "projects": normalized_projects}


def normalize_users(raw_users: dict) -> dict:
    users = {}
    for username, user in raw_users.items():
        if not isinstance(user, dict):
            continue
        username_key = str(user.get("username") or username or "").strip()
        role = str(user.get("role") or "worker").strip()
        password_hash = str(user.get("password_hash") or "").strip()
        salt = str(user.get("salt") or "").strip()
        if not username_key or role not in {"admin", "worker"} or not password_hash or not salt:
            continue
        users[username_key] = {
            "username": username_key,
            "role": role,
            "password_hash": password_hash,
            "salt": salt,
            "active": True if role == "admin" else bool(user.get("active", True)),
            "created_at": str(user.get("created_at") or utc_iso()),
        }
    if "admin" not in users:
        users["admin"] = default_state()["users"]["admin"]
    users["admin"]["active"] = True
    return users


def default_label_color(index: int) -> str:
    return DEFAULT_LABEL_COLORS[index % len(DEFAULT_LABEL_COLORS)]


def normalize_label_color(value, index: int) -> str:
    color = str(value or "").strip()
    if re.fullmatch(r"#[0-9a-fA-F]{6}", color):
        return color.lower()
    return default_label_color(index)


def normalize_labels(raw_labels) -> list[dict]:
    labels = []
    seen = set()
    if isinstance(raw_labels, list):
        for item in raw_labels:
            if isinstance(item, dict):
                name = str(item.get("name") or "").strip()
                color = normalize_label_color(item.get("color"), len(labels))
            else:
                name = str(item or "").strip()
                color = normalize_label_color(None, len(labels))
            seen_key = name.lower()
            if not name or seen_key in seen:
                continue
            seen.add(seen_key)
            labels.append({"id": len(labels), "name": name, "color": color})
    if not labels:
        labels = [{"id": idx, "name": name, "color": default_label_color(idx)} for idx, name in enumerate(DEFAULT_LABELS)]
    return labels


def normalize_project_folders(raw_folders) -> list[dict]:
    folders = []
    seen = set()
    if not isinstance(raw_folders, list):
        return folders
    for folder in raw_folders:
        if not isinstance(folder, dict):
            continue
        folder_id = str(folder.get("id") or "").strip()
        name = str(folder.get("name") or "").strip()
        root_path = str(folder.get("root_path") or "").strip()
        images_path = str(folder.get("images_path") or "").strip()
        labels_path = str(folder.get("labels_path") or "").strip()
        source_path = str(folder.get("source_path") or root_path).strip()
        if not folder_id or not name or not root_path or not images_path or not labels_path or folder_id in seen:
            continue
        seen.add(folder_id)
        folders.append(
            {
                "id": folder_id,
                "name": name,
                "root_path": root_path,
                "images_path": images_path,
                "labels_path": labels_path,
                "source_path": source_path,
                "created_at": str(folder.get("created_at") or utc_iso()),
            }
        )
    return folders


def normalize_project_assignments(raw_assignments, users: dict, valid_folder_ids: set[str]) -> dict:
    assignments = {}
    if not isinstance(raw_assignments, dict):
        return assignments
    for username, folder_ids in raw_assignments.items():
        user_key = str(username).strip()
        if user_key not in users or not isinstance(folder_ids, list):
            continue
        unique_ids = []
        for folder_id in folder_ids:
            folder_key = str(folder_id).strip()
            if folder_key in valid_folder_ids and folder_key not in unique_ids:
                unique_ids.append(folder_key)
        if unique_ids:
            assignments[user_key] = unique_ids
    return assignments


def normalize_project_folder_marks(raw_marks, users: dict, valid_folder_ids: set[str]) -> dict:
    marks = {}
    if not isinstance(raw_marks, dict):
        return marks
    for username, folder_marks in raw_marks.items():
        user_key = str(username).strip()
        if user_key not in users or not isinstance(folder_marks, dict):
            continue
        normalized = {}
        for folder_id, mark in folder_marks.items():
            folder_key = str(folder_id).strip()
            if folder_key not in valid_folder_ids or not isinstance(mark, dict):
                continue
            status = str(mark.get("status") or "").strip()
            if status not in {"working", "done", "review"}:
                continue
            normalized[folder_key] = {
                "status": status,
                "updated_at": str(mark.get("updated_at") or utc_iso()),
            }
        if normalized:
            marks[user_key] = normalized
    return marks


def normalize_project_folder_checkpoints(raw_checkpoints, users: dict, valid_folder_ids: set[str]) -> dict:
    checkpoints = {}
    if not isinstance(raw_checkpoints, dict):
        return checkpoints

    def checkpoint_from_raw(raw_checkpoint) -> dict | None:
        if not isinstance(raw_checkpoint, dict):
            return None
        rel_path = str(raw_checkpoint.get("rel_path") or "").strip()
        if not rel_path:
            return None
        try:
            rel_path = safe_relative_image_path(rel_path)
        except ApiError:
            return None
        return {
            "rel_path": rel_path,
            "updated_at": str(raw_checkpoint.get("updated_at") or utc_iso()),
        }

    def put_checkpoint(folder_key: str, raw_checkpoint) -> None:
        if folder_key not in valid_folder_ids:
            return
        checkpoint = checkpoint_from_raw(raw_checkpoint)
        if not checkpoint:
            return
        existing = checkpoints.get(folder_key)
        if not existing or checkpoint["updated_at"] >= str(existing.get("updated_at") or ""):
            checkpoints[folder_key] = checkpoint

    for key, value in raw_checkpoints.items():
        key = str(key).strip()
        if key in valid_folder_ids:
            put_checkpoint(key, value)
        elif key in users and isinstance(value, dict):
            for folder_id, checkpoint in value.items():
                put_checkpoint(str(folder_id).strip(), checkpoint)
    return checkpoints


def hash_password(password: str, salt: str | None = None) -> dict:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), 150_000)
    return {"salt": salt, "password_hash": digest.hex()}


def verify_password(password: str, user: dict) -> bool:
    salt = user.get("salt")
    stored = user.get("password_hash")
    if not salt or not stored:
        return False
    candidate = hash_password(password, salt)["password_hash"]
    return secrets.compare_digest(candidate, stored)


def public_user(username: str, user: dict) -> dict:
    return {
        "username": username,
        "role": user.get("role", "worker"),
        "active": bool(user.get("active", True)),
        "created_at": user.get("created_at"),
    }


def require_non_empty(value: str | None, field_name: str) -> str:
    if value is None or not isinstance(value, str) or not value.strip():
        raise ApiError(400, f"invalid_{field_name}", f"{field_name} 값을 입력하세요.")
    return value.strip()


def session_user_from_token(token: str) -> dict:
    session = SESSIONS.get(token)
    if not session:
        raise ApiError(401, "invalid_session", "로그인 세션이 만료되었습니다.")
    with STATE_LOCK:
        state = load_state()
        user = state["users"].get(session.get("username"))
        if not user:
            SESSIONS.pop(token, None)
            raise ApiError(401, "invalid_session", "로그인 세션이 만료되었습니다.")
        if not bool(user.get("active", True)):
            SESSIONS.pop(token, None)
            raise ApiError(403, "user_inactive", "비활성화된 계정입니다. 관리자에게 문의하세요.")
    return {"token": token, "username": session["username"], "role": user.get("role", "worker"), "created_at": session.get("created_at")}


def current_user(authorization: str | None = Header(default=None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise ApiError(401, "not_authenticated", "로그인이 필요합니다.")
    return session_user_from_token(authorization.removeprefix("Bearer ").strip())


def image_request_user(token: str = Query(default=""), authorization: str | None = Header(default=None)) -> dict:
    if authorization and authorization.startswith("Bearer "):
        return session_user_from_token(authorization.removeprefix("Bearer ").strip())
    if token:
        return session_user_from_token(token.strip())
    raise ApiError(401, "not_authenticated", "로그인이 필요합니다.")


def require_admin(user: dict = Depends(current_user)) -> dict:
    if user.get("role") != "admin":
        raise ApiError(403, "admin_required", "관리자 권한이 필요합니다.")
    return user


def project_by_id(state: dict, project_id: str) -> dict:
    for project in state["projects"]:
        if project["id"] == project_id:
            return project
    raise ApiError(404, "project_not_found", "프로젝트를 찾을 수 없습니다.")


def folder_by_id(project: dict, folder_id: str) -> dict:
    for folder in project["folders"]:
        if folder["id"] == folder_id:
            return folder
    raise ApiError(404, "folder_not_found", "YOLO 폴더를 찾을 수 없습니다.")


def resolve_server_path(raw_path: str) -> Path:
    value = require_non_empty(raw_path, "path")
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = BASE_DIR / path
    return path.resolve()


def discover_yolo_roots(path: Path) -> list[Path]:
    roots = []
    if is_yolo_root(path):
        roots.append(path)
        return roots
    if not path.is_dir():
        return roots
    try:
        pending = [(child, 1) for child in sorted([child for child in path.iterdir() if child.is_dir()], key=lambda item: item.name.lower())]
    except OSError:
        return roots
    seen = set()
    while pending:
        current, depth = pending.pop(0)
        try:
            resolved = current.resolve()
        except OSError:
            continue
        if resolved in seen:
            continue
        seen.add(resolved)
        if is_yolo_root(current):
            roots.append(current)
            continue
        if depth >= 4 or len(seen) >= 5000:
            continue
        try:
            children = sorted([child for child in current.iterdir() if child.is_dir()], key=lambda item: item.name.lower())
        except OSError:
            continue
        pending.extend((child, depth + 1) for child in children)
    return roots


def is_yolo_root(path: Path) -> bool:
    return (path / "images").is_dir()


def default_browse_roots() -> list[Path]:
    if os.name == "nt":
        roots = [Path(f"{letter}:\\") for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"]
        roots = [root for root in roots if root.is_dir()]
        if roots:
            return roots
    candidates = [Path.home(), BASE_DIR]
    roots = []
    seen = set()
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved not in seen and resolved.is_dir():
            roots.append(resolved)
            seen.add(resolved)
    return roots


def direct_yolo_child_exists(path: Path) -> bool:
    try:
        for child in path.iterdir():
            if child.is_dir() and is_yolo_root(child):
                return True
    except OSError:
        return False
    return False


def browse_server_folders(raw_path: str = "") -> dict:
    if raw_path and raw_path.strip():
        current = resolve_server_path(raw_path)
        if not current.is_dir():
            raise ApiError(400, "folder_not_found", "서버에서 해당 폴더를 찾을 수 없습니다.")
        parent = str(current.parent.resolve()) if current.parent != current else ""
        try:
            children = sorted(
                [item for item in current.iterdir() if item.is_dir()],
                key=lambda item: item.name.lower(),
            )
        except OSError as exc:
            raise ApiError(403, "folder_access_denied", "해당 폴더를 읽을 수 없습니다.") from exc
        current_path = str(current.resolve())
    else:
        current_path = ""
        parent = ""
        children = default_browse_roots()

    entries = []
    for child in children[:500]:
        try:
            resolved = child.resolve()
            entries.append(
                {
                    "name": child.name or str(resolved),
                    "path": str(resolved),
                    "is_yolo_root": is_yolo_root(resolved),
                    "has_yolo_children": direct_yolo_child_exists(resolved),
                }
            )
        except OSError:
            continue

    return {
        "current_path": current_path,
        "parent_path": parent,
        "entries": entries,
    }


def image_files(folder: dict) -> list[Path]:
    images_path = Path(folder["images_path"]).resolve()
    if not images_path.is_dir():
        return []
    files = [
        item
        for item in images_path.rglob("*")
        if item.is_file() and item.suffix.lower() in IMAGE_EXTENSIONS
    ]
    return sorted(files, key=lambda item: item.relative_to(images_path).as_posix().lower())


def image_rel_path(folder: dict, image_path: Path) -> str:
    return image_path.resolve().relative_to(Path(folder["images_path"]).resolve()).as_posix()


def safe_relative_image_path(value: str) -> str:
    rel = PurePosixPath(value)
    if rel.is_absolute() or ".." in rel.parts or not rel.name:
        raise ApiError(400, "invalid_image_path", "이미지 경로가 올바르지 않습니다.")
    if Path(rel.name).suffix.lower() not in IMAGE_EXTENSIONS:
        raise ApiError(400, "invalid_image_path", "지원하지 않는 이미지 확장자입니다.")
    return rel.as_posix()


def image_path_for(folder: dict, rel_path: str) -> Path:
    rel_path = safe_relative_image_path(rel_path)
    image_path = (Path(folder["images_path"]).resolve() / Path(rel_path)).resolve()
    try:
        image_path.relative_to(Path(folder["images_path"]).resolve())
    except ValueError as exc:
        raise ApiError(400, "invalid_image_path", "이미지 경로가 올바르지 않습니다.") from exc
    if not image_path.is_file():
        raise ApiError(404, "image_not_found", "이미지를 찾을 수 없습니다.")
    return image_path


def image_context_for_user(state: dict, image_id_value: str, user: dict) -> tuple[dict, dict, Path, str]:
    project_id, folder_id, rel_path = split_image_id(image_id_value)
    project = project_by_id(state, project_id)
    if user.get("role") != "admin" and folder_id not in project["assignments"].get(user["username"], []):
        raise ApiError(403, "not_assigned", "이 이미지가 배정된 작업 폴더에 없습니다.")
    folder = folder_by_id(project, folder_id)
    image_path = image_path_for(folder, rel_path)
    return project, folder, image_path, rel_path


def yolo_label_path_for(folder: dict, rel_path: str) -> Path:
    rel_path = safe_relative_image_path(rel_path)
    label_rel = PurePosixPath(rel_path).with_suffix(".txt")
    label_path = (Path(folder["labels_path"]).resolve() / Path(label_rel.as_posix())).resolve()
    try:
        label_path.relative_to(Path(folder["labels_path"]).resolve())
    except ValueError as exc:
        raise ApiError(400, "invalid_label_path", "라벨 경로가 올바르지 않습니다.") from exc
    return label_path


def sidecar_meta_path_for(folder: dict, rel_path: str) -> Path:
    rel_path = safe_relative_image_path(rel_path)
    meta_rel = PurePosixPath(rel_path).with_suffix(".json")
    return Path(folder["labels_path"]).resolve() / ".meta" / Path(meta_rel.as_posix())


def image_cache_headers(path: Path) -> tuple[dict[str, str], os.stat_result]:
    stat_result = path.stat()
    etag = f'W/"{stat_result.st_mtime_ns:x}-{stat_result.st_size:x}"'
    return (
        {
            "Cache-Control": f"private, max-age={IMAGE_CACHE_SECONDS}",
            "ETag": etag,
            "Last-Modified": formatdate(stat_result.st_mtime, usegmt=True),
        },
        stat_result,
    )


def is_image_not_modified(request: Request, etag: str, stat_result: os.stat_result) -> bool:
    if_none_match = request.headers.get("if-none-match", "")
    if if_none_match:
        requested_etags = [value.strip() for value in if_none_match.split(",")]
        if "*" in requested_etags or etag in requested_etags:
            return True

    if_modified_since = request.headers.get("if-modified-since")
    if if_modified_since:
        try:
            since = parsedate_to_datetime(if_modified_since)
            if since.tzinfo is None:
                since = since.replace(tzinfo=timezone.utc)
            modified_at = datetime.fromtimestamp(int(stat_result.st_mtime), timezone.utc)
            return modified_at <= since.astimezone(timezone.utc)
        except (TypeError, ValueError, OverflowError):
            return False
    return False


def image_id(project_id: str, folder_id: str, rel_path: str) -> str:
    return f"{project_id}/{folder_id}/{rel_path}"


def split_image_id(value: str) -> tuple[str, str, str]:
    parts = value.split("/", 2)
    if len(parts) != 3:
        raise ApiError(400, "invalid_image_id", "image_id는 project_id/folder_id/image_path 형식이어야 합니다.")
    project_id, folder_id, rel_path = parts
    if not project_id or not folder_id:
        raise ApiError(400, "invalid_image_id", "image_id가 올바르지 않습니다.")
    return project_id, folder_id, safe_relative_image_path(rel_path)


def cleanup_expired_claims(now: datetime | None = None) -> None:
    now = now or utc_now()
    expired = [claim_id for claim_id, claim in CLAIMS.items() if parse_utc(claim["expires_at"]) <= now]
    for claim_id in expired:
        CLAIMS.pop(claim_id, None)
        CLAIM_COUNTS["expired"] += 1


def active_claim_for_image(project_id: str, folder_id: str, rel_path: str) -> dict | None:
    for claim in CLAIMS.values():
        if claim["project_id"] == project_id and claim["folder_id"] == folder_id and claim["rel_path"] == rel_path:
            return claim
    return None


def image_to_dict(project: dict, folder: dict, image_path: Path) -> dict:
    rel_path = image_rel_path(folder, image_path)
    label_path = yolo_label_path_for(folder, rel_path)
    claim = active_claim_for_image(project["id"], folder["id"], rel_path)
    stat = image_path.stat()
    status = "available"
    if label_path.is_file():
        status = "labeled"
    elif claim:
        status = "claimed"
    return {
        "id": image_id(project["id"], folder["id"], rel_path),
        "project_id": project["id"],
        "project_name": project["name"],
        "folder_id": folder["id"],
        "folder_name": folder["name"],
        "filename": image_path.name,
        "relative_path": rel_path,
        "url": f"/images/{quote(project['id'])}/{quote(folder['id'])}/{quote(rel_path, safe='/')}",
        "size_bytes": stat.st_size,
        "mtime": stat.st_mtime,
        "status": status,
        "labeled": label_path.is_file(),
        "claimed": claim is not None,
        "claim_id": claim["claim_id"] if claim else None,
        "claim_expires_at": claim["expires_at"] if claim else None,
    }


def project_labels_for_select(project: dict) -> list[dict]:
    return [
        {
            "id": int(label["id"]),
            "name": label["name"],
            "color": normalize_label_color(label.get("color"), int(label["id"])),
        }
        for label in project["labels"]
    ]


def folder_stats(project: dict, folder: dict) -> dict:
    images = [image_to_dict(project, folder, path) for path in image_files(folder)]
    return {
        **folder,
        "exists": Path(folder["images_path"]).is_dir() and Path(folder["labels_path"]).is_dir(),
        "total": len(images),
        "labeled": sum(1 for image in images if image["labeled"]),
        "available": sum(1 for image in images if image["status"] == "available"),
        "claimed": sum(1 for image in images if image["claimed"]),
    }


def folder_checkpoint_summary(folder: dict, checkpoint: dict | None) -> dict:
    files = image_files(folder)
    total = len(files)
    rel_path = str((checkpoint or {}).get("rel_path") or "")
    position = 0
    if rel_path:
        for index, image_path in enumerate(files):
            if image_rel_path(folder, image_path) == rel_path:
                position = index + 1
                break
    return {
        "position": position,
        "total": total,
        "rel_path": rel_path,
        "updated_at": str((checkpoint or {}).get("updated_at") or ""),
    }


def folder_mark_summary(project: dict, folder_id: str) -> dict:
    latest = None
    for username, folder_marks in project.get("folder_marks", {}).items():
        if not isinstance(folder_marks, dict):
            continue
        mark = folder_marks.get(folder_id)
        if not isinstance(mark, dict):
            continue
        status = str(mark.get("status") or "").strip()
        if status not in {"working", "done", "review"}:
            continue
        candidate = {
            "username": username,
            "status": status,
            "updated_at": str(mark.get("updated_at") or ""),
        }
        if latest is None or candidate["updated_at"] >= latest["updated_at"]:
            latest = candidate
    return latest or {}


def public_project(project: dict, include_stats: bool = True) -> dict:
    folders = []
    folder_checkpoints = project.get("folder_checkpoints", {})
    for folder in project["folders"]:
        folder_data = folder_stats(project, folder) if include_stats else dict(folder)
        folder_data["mark"] = folder_mark_summary(project, folder["id"])
        folder_data["checkpoint"] = folder_checkpoint_summary(folder, folder_checkpoints.get(folder["id"]))
        folders.append(folder_data)
    return {
        "id": project["id"],
        "name": project["name"],
        "labels": project_labels_for_select(project),
        "folders": folders,
        "assignments": project["assignments"],
        "created_at": project["created_at"],
    }


def assigned_pairs_for_user(state: dict, username: str, role: str) -> list[tuple[dict, dict]]:
    pairs = []
    for project in state["projects"]:
        if role == "admin":
            folder_ids = [folder["id"] for folder in project["folders"]]
        else:
            folder_ids = project["assignments"].get(username, [])
        for folder in project["folders"]:
            if folder["id"] in folder_ids:
                pairs.append((project, folder))
    return pairs


def admin_config() -> dict:
    with STATE_LOCK:
        cleanup_expired_claims()
        state = load_state()
        return {
            "users": [public_user(username, user) for username, user in sorted(state["users"].items())],
            "projects": [public_project(project) for project in state["projects"]],
        }


def worker_config(user: dict) -> dict:
    with STATE_LOCK:
        cleanup_expired_claims()
        state = load_state()
        projects = []
        for project in state["projects"]:
            assigned = project["assignments"].get(user["username"], [])
            user_marks = project.get("folder_marks", {}).get(user["username"], {})
            folder_checkpoints = project.get("folder_checkpoints", {})
            folders = []
            for folder in project["folders"]:
                if folder["id"] not in assigned:
                    continue
                folder_data = folder_stats(project, folder)
                folder_data["worker_mark"] = user_marks.get(folder["id"], {})
                folder_data["worker_checkpoint"] = folder_checkpoint_summary(folder, folder_checkpoints.get(folder["id"]))
                folders.append(folder_data)
            if folders:
                projects.append(
                    {
                        "id": project["id"],
                        "name": project["name"],
                        "labels": project_labels_for_select(project),
                        "folders": folders,
                    }
                )
        return {"user": {"username": user["username"], "role": user["role"]}, "projects": projects}


def set_worker_folder_mark(payload: FolderMarkPayload, user: dict) -> dict:
    project_id = require_non_empty(payload.project_id, "project_id")
    folder_id = require_non_empty(payload.folder_id, "folder_id")
    status = require_non_empty(payload.status, "status")
    if status not in {"working", "done", "review"}:
        raise ApiError(400, "invalid_status", "status는 working, done, review 중 하나여야 합니다.")
    now_text = utc_iso()
    with STATE_LOCK:
        state = load_state()
        project = project_by_id(state, project_id)
        folder_by_id(project, folder_id)
        if user.get("role") != "admin" and folder_id not in project["assignments"].get(user["username"], []):
            raise ApiError(403, "folder_not_assigned", "배정되지 않은 작업 폴더입니다.")
        marks = project.setdefault("folder_marks", {}).setdefault(user["username"], {})
        marks[folder_id] = {"status": status, "updated_at": now_text}
        write_state(state)
    return {"ok": True, "project_id": project_id, "folder_id": folder_id, "mark": marks[folder_id]}


def set_worker_checkpoint(payload: WorkerCheckpointPayload, user: dict) -> dict:
    project_id, folder_id, rel_path = split_image_id(payload.image_id)
    now_text = utc_iso()
    with STATE_LOCK:
        state = load_state()
        project = project_by_id(state, project_id)
        folder = folder_by_id(project, folder_id)
        if user.get("role") != "admin" and folder_id not in project["assignments"].get(user["username"], []):
            raise ApiError(403, "folder_not_assigned", "배정되지 않은 작업 폴더입니다.")
        image_path_for(folder, rel_path)
        checkpoints = project.setdefault("folder_checkpoints", {})
        checkpoints[folder_id] = {"rel_path": rel_path, "updated_at": now_text}
        summary = folder_checkpoint_summary(folder, checkpoints[folder_id])
        write_state(state)
    return {"ok": True, "project_id": project_id, "folder_id": folder_id, "checkpoint": summary}


def create_user(payload: UserCreatePayload) -> dict:
    username = require_non_empty(payload.username, "username")
    password = require_non_empty(payload.password, "password")
    role = payload.role.strip() if isinstance(payload.role, str) else "worker"
    if role not in {"admin", "worker"}:
        raise ApiError(400, "invalid_role", "role은 admin 또는 worker여야 합니다.")
    with STATE_LOCK:
        state = load_state()
        if username in state["users"]:
            raise ApiError(409, "user_exists", "이미 존재하는 사용자입니다.")
        state["users"][username] = {
            "username": username,
            "role": role,
            **hash_password(password),
            "active": True,
            "created_at": utc_iso(),
        }
        write_state(state)
        return {"ok": True, "user": public_user(username, state["users"][username])}


def remove_user_runtime_state(username: str) -> None:
    for token, session in list(SESSIONS.items()):
        if session.get("username") == username:
            SESSIONS.pop(token, None)
    for claim_id, claim in list(CLAIMS.items()):
        if claim.get("username") == username:
            CLAIMS.pop(claim_id, None)


def set_user_active(payload: UserActivePayload) -> dict:
    username = require_non_empty(payload.username, "username")
    with STATE_LOCK:
        state = load_state()
        user = state["users"].get(username)
        if not user:
            raise ApiError(404, "user_not_found", "사용자를 찾을 수 없습니다.")
        if user.get("role") == "admin":
            raise ApiError(400, "admin_user_locked", "관리자 계정은 비활성화할 수 없습니다.")
        user["active"] = bool(payload.active)
        if not user["active"]:
            remove_user_runtime_state(username)
        write_state(state)
        return {"ok": True, "user": public_user(username, user)}


def remove_user(payload: UserRemovePayload) -> dict:
    username = require_non_empty(payload.username, "username")
    with STATE_LOCK:
        state = load_state()
        user = state["users"].get(username)
        if not user:
            raise ApiError(404, "user_not_found", "사용자를 찾을 수 없습니다.")
        if user.get("role") == "admin":
            raise ApiError(400, "admin_user_locked", "관리자 계정은 삭제할 수 없습니다.")
        state["users"].pop(username, None)
        for project in state["projects"]:
            project.get("assignments", {}).pop(username, None)
            project.get("folder_marks", {}).pop(username, None)
        remove_user_runtime_state(username)
        write_state(state)
    return {"ok": True, "username": username}


def create_project(payload: ProjectCreatePayload) -> dict:
    name = require_non_empty(payload.name, "name")
    labels = normalize_labels(payload.labels or DEFAULT_LABELS)
    with STATE_LOCK:
        state = load_state()
        project = {
            "id": "p_" + uuid.uuid4().hex[:12],
            "name": name,
            "labels": labels,
            "folders": [],
            "assignments": {},
            "folder_marks": {},
            "folder_checkpoints": {},
            "created_at": utc_iso(),
        }
        state["projects"].append(project)
        write_state(state)
        return {"ok": True, "project": public_project(project)}


def update_project(payload: ProjectUpdatePayload) -> dict:
    project_id = require_non_empty(payload.project_id, "project_id")
    name = require_non_empty(payload.name, "name")
    labels = normalize_labels(payload.labels)
    with STATE_LOCK:
        state = load_state()
        project = project_by_id(state, project_id)
        project["name"] = name
        project["labels"] = labels
        write_classes_files(project)
        write_state(state)
        return {"ok": True, "project": public_project(project)}


def remove_project(payload: ProjectRemovePayload) -> dict:
    project_id = require_non_empty(payload.project_id, "project_id")
    with STATE_LOCK:
        state = load_state()
        project_by_id(state, project_id)
        state["projects"] = [project for project in state["projects"] if project["id"] != project_id]
        for claim_id, claim in list(CLAIMS.items()):
            if claim["project_id"] == project_id:
                CLAIMS.pop(claim_id, None)
        write_state(state)
    return {"ok": True, "project_id": project_id}


def update_project_labels(payload: ProjectLabelsPayload) -> dict:
    project_id = require_non_empty(payload.project_id, "project_id")
    labels = normalize_labels(payload.labels)
    with STATE_LOCK:
        state = load_state()
        project = project_by_id(state, project_id)
        project["labels"] = labels
        write_classes_files(project)
        write_state(state)
        return {"ok": True, "project": public_project(project)}


def add_yolo_folders(payload: YoloFolderPayload) -> dict:
    project_id = require_non_empty(payload.project_id, "project_id")
    root = resolve_server_path(payload.path)
    if not root.is_dir():
        raise ApiError(400, "folder_not_found", "서버에서 해당 폴더를 찾을 수 없습니다.")
    roots = discover_yolo_roots(root)
    if not roots:
        raise ApiError(400, "not_yolo_folder", "images 폴더를 가진 YOLO 폴더를 찾지 못했습니다.")
    source_path = str(root.resolve())

    with STATE_LOCK:
        state = load_state()
        project = project_by_id(state, project_id)
        existing_roots = {str(Path(folder["root_path"]).resolve()) for folder in project["folders"]}
        added = []
        for yolo_root in roots:
            resolved = str(yolo_root.resolve())
            labels_path = (yolo_root / "labels").resolve()
            try:
                labels_path.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                raise ApiError(403, "labels_folder_create_failed", "labels 폴더를 생성할 수 없습니다.") from exc
            if resolved in existing_roots:
                continue
            folder = {
                "id": "f_" + uuid.uuid4().hex[:12],
                "name": yolo_root.name,
                "root_path": resolved,
                "images_path": str((yolo_root / "images").resolve()),
                "labels_path": str(labels_path),
                "source_path": source_path,
                "created_at": utc_iso(),
            }
            project["folders"].append(folder)
            added.append(folder_stats(project, folder))
        write_classes_files(project)
        write_state(state)
    return {"ok": True, "added": added, "count": len(added)}


def remove_yolo_folder(payload: FolderRemovePayload) -> dict:
    project_id = require_non_empty(payload.project_id, "project_id")
    folder_id = require_non_empty(payload.folder_id, "folder_id")
    with STATE_LOCK:
        state = load_state()
        project = project_by_id(state, project_id)
        folder_by_id(project, folder_id)
        project["folders"] = [folder for folder in project["folders"] if folder["id"] != folder_id]
        for username in list(project["assignments"].keys()):
            project["assignments"][username] = [
                assigned_id for assigned_id in project["assignments"][username] if assigned_id != folder_id
            ]
            if not project["assignments"][username]:
                project["assignments"].pop(username, None)
        for username in list(project.get("folder_marks", {}).keys()):
            project["folder_marks"][username].pop(folder_id, None)
            if not project["folder_marks"][username]:
                project["folder_marks"].pop(username, None)
        project.get("folder_checkpoints", {}).pop(folder_id, None)
        for claim_id, claim in list(CLAIMS.items()):
            if claim["project_id"] == project_id and claim["folder_id"] == folder_id:
                CLAIMS.pop(claim_id, None)
        write_state(state)
    return {"ok": True, "project_id": project_id, "folder_id": folder_id}


def assign_folder(payload: AssignmentPayload) -> dict:
    username = require_non_empty(payload.username, "username")
    project_id = require_non_empty(payload.project_id, "project_id")
    folder_id = require_non_empty(payload.folder_id, "folder_id")
    with STATE_LOCK:
        state = load_state()
        if username not in state["users"]:
            raise ApiError(404, "user_not_found", "사용자를 찾을 수 없습니다.")
        project = project_by_id(state, project_id)
        folder_by_id(project, folder_id)
        assigned = project["assignments"].setdefault(username, [])
        if folder_id not in assigned:
            assigned.append(folder_id)
            write_state(state)
    return {"ok": True, "username": username, "project_id": project_id, "folder_ids": project["assignments"][username]}


def unassign_folder(payload: AssignmentPayload) -> dict:
    username = require_non_empty(payload.username, "username")
    project_id = require_non_empty(payload.project_id, "project_id")
    folder_id = require_non_empty(payload.folder_id, "folder_id")
    with STATE_LOCK:
        state = load_state()
        project = project_by_id(state, project_id)
        assigned = project["assignments"].get(username, [])
        project["assignments"][username] = [assigned_id for assigned_id in assigned if assigned_id != folder_id]
        if not project["assignments"][username]:
            project["assignments"].pop(username, None)
        if username in project.get("folder_marks", {}):
            project["folder_marks"][username].pop(folder_id, None)
            if not project["folder_marks"][username]:
                project["folder_marks"].pop(username, None)
        for claim_id, claim in list(CLAIMS.items()):
            if claim.get("username") == username and claim["project_id"] == project_id and claim["folder_id"] == folder_id:
                CLAIMS.pop(claim_id, None)
        write_state(state)
    return {"ok": True, "username": username, "project_id": project_id, "folder_id": folder_id}


def set_project_assignments(payload: AssignmentBulkPayload) -> dict:
    username = require_non_empty(payload.username, "username")
    project_id = require_non_empty(payload.project_id, "project_id")
    requested_ids = []
    for folder_id in payload.folder_ids:
        folder_key = require_non_empty(folder_id, "folder_id")
        if folder_key not in requested_ids:
            requested_ids.append(folder_key)

    with STATE_LOCK:
        state = load_state()
        if username not in state["users"]:
            raise ApiError(404, "user_not_found", "사용자를 찾을 수 없습니다.")
        project = project_by_id(state, project_id)
        valid_folder_ids = {folder["id"] for folder in project["folders"]}
        invalid_ids = [folder_id for folder_id in requested_ids if folder_id not in valid_folder_ids]
        if invalid_ids:
            raise ApiError(400, "invalid_folder", "프로젝트에 없는 YOLO 폴더가 포함되어 있습니다.")
        taken_ids = []
        for other_username, assigned_ids in project["assignments"].items():
            if other_username == username:
                continue
            for folder_id in requested_ids:
                if folder_id in assigned_ids and folder_id not in taken_ids:
                    taken_ids.append(folder_id)
        if taken_ids:
            raise ApiError(409, "folder_already_assigned", "이미 다른 작업자에게 배정된 YOLO 폴더가 포함되어 있습니다.")

        previous_ids = set(project["assignments"].get(username, []))
        next_ids = set(requested_ids)
        removed_ids = previous_ids - next_ids
        if requested_ids:
            project["assignments"][username] = requested_ids
        else:
            project["assignments"].pop(username, None)

        for claim_id, claim in list(CLAIMS.items()):
            if claim.get("username") == username and claim["project_id"] == project_id and claim["folder_id"] in removed_ids:
                CLAIMS.pop(claim_id, None)

        write_state(state)
    return {"ok": True, "username": username, "project_id": project_id, "folder_ids": requested_ids}


def write_classes_files(project: dict) -> None:
    content = "\n".join(label["name"] for label in project["labels"]) + "\n"
    for folder in project["folders"]:
        root = Path(folder["root_path"])
        try:
            (root / "classes.txt").write_text(content, encoding="utf-8", newline="\n")
        except OSError:
            continue


def list_images_for_user(user: dict) -> dict:
    with STATE_LOCK:
        cleanup_expired_claims()
        state = load_state()
        images = [
            image_to_dict(project, folder, image_path)
            for project, folder in assigned_pairs_for_user(state, user["username"], user["role"])
            for image_path in image_files(folder)
        ]
    return {"images": images, "count": len(images)}


def stats_for_user(user: dict) -> dict:
    images = list_images_for_user(user)["images"]
    return {
        "images": {
            "total": len(images),
            "labeled": sum(1 for image in images if image["labeled"]),
            "unlabeled": sum(1 for image in images if not image["labeled"]),
            "available": sum(1 for image in images if image["status"] == "available"),
        },
        "claims": {
            "active": len(CLAIMS),
            "released": CLAIM_COUNTS["released"],
            "completed": CLAIM_COUNTS["completed"],
            "expired": CLAIM_COUNTS["expired"],
            "total": len(CLAIMS),
        },
        "claim_ttl_seconds": CLAIM_TTL_SECONDS,
        "generated_at": utc_iso(),
    }


def claim_next_image(user: dict, payload: ClaimPayload | None = None) -> dict:
    now = utc_now()
    claim_id = str(uuid.uuid4())
    expires_at = utc_iso(now + timedelta(seconds=CLAIM_TTL_SECONDS))
    requested_project_id = str(payload.project_id or "").strip() if payload else ""
    requested_folder_id = str(payload.folder_id or "").strip() if payload else ""
    with STATE_LOCK:
        cleanup_expired_claims(now)
        state = load_state()
        pairs = assigned_pairs_for_user(state, user["username"], user["role"])
        if requested_project_id or requested_folder_id:
            pairs = [
                (project, folder)
                for project, folder in pairs
                if (not requested_project_id or project["id"] == requested_project_id)
                and (not requested_folder_id or folder["id"] == requested_folder_id)
            ]
        if not pairs:
            raise ApiError(403, "no_assignment", "배정된 작업 폴더가 없습니다.")
        for project, folder in pairs:
            for path in image_files(folder):
                rel_path = image_rel_path(folder, path)
                if yolo_label_path_for(folder, rel_path).is_file():
                    continue
                if active_claim_for_image(project["id"], folder["id"], rel_path):
                    continue
                claim = {
                    "claim_id": claim_id,
                    "project_id": project["id"],
                    "project_name": project["name"],
                    "folder_id": folder["id"],
                    "folder_name": folder["name"],
                    "rel_path": rel_path,
                    "image_id": image_id(project["id"], folder["id"], rel_path),
                    "username": user["username"],
                    "created_at": utc_iso(now),
                    "expires_at": expires_at,
                }
                CLAIMS[claim_id] = claim
                return {
                    "image": image_to_dict(project, folder, path),
                    "claim_id": claim_id,
                    "expires_at": expires_at,
                    "labels": project_labels_for_select(project),
                }
    if requested_folder_id:
        raise ApiError(404, "no_available_images", "선택한 폴더에 작업 가능한 이미지가 없습니다.")
    raise ApiError(404, "no_available_images", "작업 가능한 이미지가 없습니다.")


def save_label(payload: LabelPayload, user: dict) -> dict:
    project_id, folder_id, rel_path = split_image_id(payload.image_id)
    claim_id = require_non_empty(payload.claim_id, "claim_id")
    now_text = utc_iso()
    with STATE_LOCK:
        cleanup_expired_claims()
        state = load_state()
        project = project_by_id(state, project_id)
        folder = folder_by_id(project, folder_id)
        image_path = image_path_for(folder, rel_path)
        claim = CLAIMS.get(claim_id)
        if claim is None:
            raise ApiError(404, "claim_not_found", "작업 선점이 없거나 만료되었습니다.")
        if claim["image_id"] != payload.image_id:
            raise ApiError(409, "claim_image_mismatch", "선점한 이미지와 저장 요청 이미지가 다릅니다.")
        if claim["username"] != user["username"] and user["role"] != "admin":
            raise ApiError(403, "user_mismatch", "현재 로그인 사용자와 선점 사용자가 다릅니다.")
        label = label_by_id(project, payload.label_id)
        label_path = yolo_label_path_for(folder, rel_path)
        if label_path.is_file():
            raise ApiError(409, "already_labeled", "이미 라벨이 저장된 이미지입니다.")
        write_yolo_label(label_path, int(label["id"]))
        write_label_meta(
            sidecar_meta_path_for(folder, rel_path),
            {
                "image_id": payload.image_id,
                "project_id": project_id,
                "project_name": project["name"],
                "folder_id": folder_id,
                "folder_name": folder["name"],
                "image_path": str(image_path),
                "label_id": label["id"],
                "label_name": label["name"],
                "notes": payload.notes or "",
                "username": user["username"],
                "claim_id": claim_id,
                "created_at": now_text,
            },
        )
        CLAIMS.pop(claim_id, None)
        CLAIM_COUNTS["completed"] += 1
        image = image_to_dict(project, folder, image_path)
    return {
        "ok": True,
        "label_path": str(label_path),
        "meta_path": str(sidecar_meta_path_for(folder, rel_path)),
        "claim_id": claim_id,
        "completed_at": now_text,
        "image": image,
    }


def label_by_id(project: dict, label_id: int) -> dict:
    for label in project["labels"]:
        if int(label["id"]) == int(label_id):
            return label
    raise ApiError(400, "invalid_label", "프로젝트 라벨 목록에 없는 라벨입니다.")


def write_yolo_label(path: Path, label_id: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    # Prototype behavior: class-only labeling is stored as a full-image YOLO box.
    tmp_path.write_text(f"{label_id} 0.5 0.5 1.0 1.0\n", encoding="utf-8", newline="\n")
    os.replace(tmp_path, path)


def validated_annotation(project: dict, box: AnnotationBox) -> dict:
    label = label_by_id(project, box.label_id)
    values = {
        "x": float(box.x),
        "y": float(box.y),
        "width": float(box.width),
        "height": float(box.height),
    }
    if values["width"] <= 0 or values["height"] <= 0:
        raise ApiError(400, "invalid_box", "박스 크기는 0보다 커야 합니다.")
    for key, value in values.items():
        if value < 0 or value > 1:
            raise ApiError(400, "invalid_box", "박스 좌표는 0과 1 사이여야 합니다.")
    return {
        "label_id": int(label["id"]),
        "label_name": label["name"],
        "label_color": normalize_label_color(label.get("color"), int(label["id"])),
        **values,
    }


def read_yolo_annotations(path: Path, project: dict) -> list[dict]:
    if not path.is_file():
        return []
    annotations = []
    for line in path.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        try:
            label_id = int(float(parts[0]))
            label = label_by_id(project, label_id)
            x, y, width, height = [float(value) for value in parts[1:5]]
        except (ValueError, ApiError):
            continue
        annotations.append(
            {
                "label_id": int(label["id"]),
                "label_name": label["name"],
                "label_color": normalize_label_color(label.get("color"), int(label["id"])),
                "x": x,
                "y": y,
                "width": width,
                "height": height,
            }
        )
    return annotations


def write_yolo_annotations(path: Path, annotations: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    lines = [
        f"{item['label_id']} {item['x']:.6f} {item['y']:.6f} {item['width']:.6f} {item['height']:.6f}"
        for item in annotations
    ]
    tmp_path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8", newline="\n")
    os.replace(tmp_path, path)


def annotations_for_image(image_id_value: str, user: dict) -> dict:
    with STATE_LOCK:
        state = load_state()
        project, folder, image_path, rel_path = image_context_for_user(state, image_id_value, user)
        label_path = yolo_label_path_for(folder, rel_path)
        annotations = read_yolo_annotations(label_path, project)
        return {
            "image_id": image_id_value,
            "image": image_to_dict(project, folder, image_path),
            "labels": project_labels_for_select(project),
            "annotations": annotations,
        }


def save_annotations(payload: AnnotationSavePayload, user: dict) -> dict:
    now_text = utc_iso()
    with STATE_LOCK:
        state = load_state()
        project, folder, image_path, rel_path = image_context_for_user(state, payload.image_id, user)
        claim_id = str(payload.claim_id or "").strip()
        if claim_id:
            claim = CLAIMS.get(claim_id)
            if claim is None:
                raise ApiError(404, "claim_not_found", "작업 선점이 없거나 만료되었습니다.")
            if claim["image_id"] != payload.image_id:
                raise ApiError(409, "claim_image_mismatch", "선점한 이미지와 저장 요청 이미지가 다릅니다.")
            if claim["username"] != user["username"] and user["role"] != "admin":
                raise ApiError(403, "user_mismatch", "현재 로그인 사용자와 선점 사용자가 다릅니다.")
        annotations = [validated_annotation(project, box) for box in payload.annotations]
        label_path = yolo_label_path_for(folder, rel_path)
        write_yolo_annotations(label_path, annotations)
        write_label_meta(
            sidecar_meta_path_for(folder, rel_path),
            {
                "image_id": payload.image_id,
                "project_id": project["id"],
                "project_name": project["name"],
                "folder_id": folder["id"],
                "folder_name": folder["name"],
                "image_path": str(image_path),
                "annotations": annotations,
                "username": user["username"],
                "created_at": now_text,
            },
        )
        if claim_id:
            CLAIMS.pop(claim_id, None)
            CLAIM_COUNTS["completed"] += 1
        image = image_to_dict(project, folder, image_path)
    return {
        "ok": True,
        "image_id": payload.image_id,
        "label_path": str(label_path),
        "meta_path": str(sidecar_meta_path_for(folder, rel_path)),
        "annotations": annotations,
        "saved_at": now_text,
        "image": image,
    }


def write_label_meta(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")
    os.replace(tmp_path, path)


def release_claim(payload: ReleasePayload, user: dict) -> dict:
    claim_id = require_non_empty(payload.claim_id, "claim_id")
    with STATE_LOCK:
        cleanup_expired_claims()
        claim = CLAIMS.get(claim_id)
        if claim is None:
            raise ApiError(404, "claim_not_found", "작업 선점이 없거나 만료되었습니다.")
        if claim["username"] != user["username"] and user["role"] != "admin":
            raise ApiError(403, "user_mismatch", "현재 로그인 사용자와 선점 사용자가 다릅니다.")
        CLAIMS.pop(claim_id, None)
        CLAIM_COUNTS["released"] += 1
    return {"ok": True, "claim_id": claim_id, "status": "released", "released_at": utc_iso()}


@app.exception_handler(ApiError)
async def handle_api_error(_: Request, exc: ApiError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status,
        content={"error": {"code": exc.code, "message": exc.message}, "message": exc.message},
    )


@app.exception_handler(RequestValidationError)
async def handle_validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={
            "error": {"code": "validation_error", "message": "요청 값이 올바르지 않습니다."},
            "message": "요청 값이 올바르지 않습니다.",
            "details": exc.errors(),
        },
    )


@app.on_event("startup")
def startup() -> None:
    ensure_storage()


@app.get("/")
def root() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.post("/api/auth/login")
def api_login(payload: LoginPayload) -> dict:
    username = require_non_empty(payload.username, "username")
    password = require_non_empty(payload.password, "password")
    with STATE_LOCK:
        state = load_state()
        user = state["users"].get(username)
        if not user or not verify_password(password, user):
            raise ApiError(401, "login_failed", "아이디 또는 비밀번호가 올바르지 않습니다.")
        if not bool(user.get("active", True)):
            raise ApiError(403, "user_inactive", "비활성화된 계정입니다. 관리자에게 문의하세요.")
        token = secrets.token_urlsafe(32)
        SESSIONS[token] = {"username": username, "role": user.get("role", "worker"), "created_at": utc_iso()}
        return {"token": token, "user": public_user(username, user)}


@app.get("/api/auth/me")
def api_me(user: dict = Depends(current_user)) -> dict:
    return {"user": {"username": user["username"], "role": user["role"]}}


@app.post("/api/auth/logout")
def api_logout(user: dict = Depends(current_user)) -> dict:
    SESSIONS.pop(user["token"], None)
    return {"ok": True}


@app.get("/api/admin/config")
def api_admin_config(_: dict = Depends(require_admin)) -> dict:
    return admin_config()


@app.get("/api/admin/folders/browse")
def api_admin_folders_browse(path: str = Query(default=""), _: dict = Depends(require_admin)) -> dict:
    return browse_server_folders(path)


@app.post("/api/admin/users", status_code=201)
def api_admin_users(payload: UserCreatePayload, _: dict = Depends(require_admin)) -> dict:
    return create_user(payload)


@app.post("/api/admin/users/active")
def api_admin_users_active(payload: UserActivePayload, _: dict = Depends(require_admin)) -> dict:
    return set_user_active(payload)


@app.post("/api/admin/users/remove")
def api_admin_users_remove(payload: UserRemovePayload, _: dict = Depends(require_admin)) -> dict:
    return remove_user(payload)


@app.post("/api/admin/projects", status_code=201)
def api_admin_projects(payload: ProjectCreatePayload, _: dict = Depends(require_admin)) -> dict:
    return create_project(payload)


@app.post("/api/admin/projects/update")
def api_admin_projects_update(payload: ProjectUpdatePayload, _: dict = Depends(require_admin)) -> dict:
    return update_project(payload)


@app.post("/api/admin/projects/remove")
def api_admin_projects_remove(payload: ProjectRemovePayload, _: dict = Depends(require_admin)) -> dict:
    return remove_project(payload)


@app.post("/api/admin/projects/labels")
def api_admin_project_labels(payload: ProjectLabelsPayload, _: dict = Depends(require_admin)) -> dict:
    return update_project_labels(payload)


@app.post("/api/admin/projects/folders")
def api_admin_project_folders(payload: YoloFolderPayload, _: dict = Depends(require_admin)) -> dict:
    return add_yolo_folders(payload)


@app.post("/api/admin/projects/folders/remove")
def api_admin_project_folders_remove(payload: FolderRemovePayload, _: dict = Depends(require_admin)) -> dict:
    return remove_yolo_folder(payload)


@app.post("/api/admin/assignments")
def api_admin_assignments(payload: AssignmentPayload, _: dict = Depends(require_admin)) -> dict:
    return assign_folder(payload)


@app.post("/api/admin/assignments/bulk")
def api_admin_assignments_bulk(payload: AssignmentBulkPayload, _: dict = Depends(require_admin)) -> dict:
    return set_project_assignments(payload)


@app.post("/api/admin/unassign")
def api_admin_unassign(payload: AssignmentPayload, _: dict = Depends(require_admin)) -> dict:
    return unassign_folder(payload)


@app.get("/api/worker/config")
def api_worker_config(user: dict = Depends(current_user)) -> dict:
    return worker_config(user)


@app.post("/api/worker/folder-mark")
def api_worker_folder_mark(payload: FolderMarkPayload, user: dict = Depends(current_user)) -> dict:
    return set_worker_folder_mark(payload, user)


@app.post("/api/worker/checkpoint")
def api_worker_checkpoint(payload: WorkerCheckpointPayload, user: dict = Depends(current_user)) -> dict:
    return set_worker_checkpoint(payload, user)


@app.get("/api/stats")
def api_stats(user: dict = Depends(current_user)) -> dict:
    return stats_for_user(user)


@app.get("/api/images")
def api_images(user: dict = Depends(current_user)) -> dict:
    return list_images_for_user(user)


@app.get("/api/annotations")
def api_annotations(image_id: str = Query(...), user: dict = Depends(current_user)) -> dict:
    return annotations_for_image(image_id, user)


@app.post("/api/annotations")
def api_annotations_save(payload: AnnotationSavePayload, user: dict = Depends(current_user)) -> dict:
    return save_annotations(payload, user)


@app.post("/api/claim")
def api_claim(payload: ClaimPayload | None = None, user: dict = Depends(current_user)) -> dict:
    return claim_next_image(user, payload)


@app.post("/api/labels", status_code=201)
def api_labels(payload: LabelPayload, user: dict = Depends(current_user)) -> dict:
    return save_label(payload, user)


@app.post("/api/release")
def api_release(payload: ReleasePayload, user: dict = Depends(current_user)) -> dict:
    return release_claim(payload, user)


@app.get("/images/{project_id}/{folder_id}/{image_path:path}")
def api_image_file(
    request: Request,
    project_id: str,
    folder_id: str,
    image_path: str,
    user: dict = Depends(image_request_user),
) -> Response:
    with STATE_LOCK:
        state = load_state()
        project = project_by_id(state, project_id)
        if user.get("role") != "admin" and folder_id not in project["assignments"].get(user["username"], []):
            raise ApiError(403, "folder_not_assigned", "배정되지 않은 작업 폴더입니다.")
        folder = folder_by_id(project, folder_id)
        path = image_path_for(folder, image_path)
    headers, stat_result = image_cache_headers(path)
    if is_image_not_modified(request, headers["ETag"], stat_result):
        return Response(status_code=304, headers=headers)
    return FileResponse(path, headers=headers, stat_result=stat_result)


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the FastAPI labeling server.")
    parser.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    parser.add_argument("--claim-ttl-seconds", type=int, default=CLAIM_TTL_SECONDS)
    return parser.parse_args()


def main() -> None:
    global CLAIM_TTL_SECONDS
    args = parse_args()
    CLAIM_TTL_SECONDS = max(1, args.claim_ttl_seconds)
    ensure_storage()
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
