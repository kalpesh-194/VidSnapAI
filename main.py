from __future__ import annotations

import base64
import json
import mimetypes
import uuid
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, render_template, request, url_for
from werkzeug.utils import secure_filename


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
REELS_DIR = STATIC_DIR / "reels"
THUMBNAILS_DIR = STATIC_DIR / "thumbnails"
DATA_DIR = BASE_DIR / "data"
REELS_INDEX = DATA_DIR / "reels.json"

ALLOWED_REEL_TYPES = {"video/webm", "video/mp4"}
ALLOWED_THUMBNAIL_TYPES = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
}

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 80 * 1024 * 1024


def ensure_storage() -> None:
    REELS_DIR.mkdir(parents=True, exist_ok=True)
    THUMBNAILS_DIR.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not REELS_INDEX.exists():
        REELS_INDEX.write_text("[]", encoding="utf-8")


def load_reels() -> list[dict]:
    ensure_storage()
    try:
        reels = json.loads(REELS_INDEX.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []

    if not isinstance(reels, list):
        return []

    return sorted(
        (reel for reel in reels if isinstance(reel, dict)),
        key=lambda reel: reel.get("created_at", ""),
        reverse=True,
    )


def save_reels(reels: list[dict]) -> None:
    ensure_storage()
    REELS_INDEX.write_text(json.dumps(reels, indent=2), encoding="utf-8")


def list_songs() -> list[dict]:
    songs_dir = STATIC_DIR / "songs"
    if not songs_dir.exists():
        return []

    songs = []
    for path in sorted(songs_dir.iterdir()):
        if path.suffix.lower() not in {".mp3", ".wav", ".m4a", ".ogg"}:
            continue
        songs.append(
            {
                "filename": f"songs/{path.name}",
                "label": f"Song {path.stem}",
            }
        )
    return songs


def parse_int(value: str | None, default: int = 0) -> int:
    try:
        return int(value or default)
    except (TypeError, ValueError):
        return default


def parse_float(value: str | None, default: float = 0.0) -> float:
    try:
        return float(value or default)
    except (TypeError, ValueError):
        return default


def save_thumbnail(data_url: str | None, reel_id: str) -> str | None:
    if not data_url or "," not in data_url:
        return None

    header, encoded = data_url.split(",", 1)
    if ";base64" not in header:
        return None

    mime_type = header.replace("data:", "").split(";", 1)[0]
    extension = ALLOWED_THUMBNAIL_TYPES.get(mime_type)
    if extension is None:
        return None

    try:
        image_bytes = base64.b64decode(encoded, validate=True)
    except ValueError:
        return None

    if len(image_bytes) > 5 * 1024 * 1024:
        return None

    filename = f"{reel_id}.{extension}"
    (THUMBNAILS_DIR / filename).write_bytes(image_bytes)
    return f"thumbnails/{filename}"


@app.template_filter("friendly_date")
def friendly_date(value: str | None) -> str:
    if not value:
        return "Just now"
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return value
    return parsed.astimezone().strftime("%d %b %Y, %I:%M %p")


@app.context_processor
def inject_globals() -> dict:
    return {"current_year": datetime.now().year}


@app.route("/")
def home():
    return render_template("index.html", latest_reels=load_reels()[:3])


@app.route("/create", methods=["GET"])
def create():
    return render_template("create.html", songs=list_songs())


@app.post("/api/reels")
def create_reel():
    ensure_storage()

    reel_file = request.files.get("reel")
    if reel_file is None or reel_file.filename == "":
        return jsonify({"error": "No generated reel was received."}), 400

    content_type = reel_file.content_type or mimetypes.guess_type(reel_file.filename)[0]
    if content_type not in ALLOWED_REEL_TYPES:
        return jsonify({"error": "Only WebM or MP4 reels can be saved."}), 400

    title = (request.form.get("title") or "Untitled Reel").strip()[:80]
    safe_title = secure_filename(title) or "reel"
    extension = ".mp4" if content_type == "video/mp4" else ".webm"
    reel_id = uuid.uuid4().hex[:12]
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    filename = f"{timestamp}_{reel_id}_{safe_title}{extension}"

    reel_file.save(REELS_DIR / filename)
    thumbnail = save_thumbnail(request.form.get("thumbnail"), reel_id)

    record = {
        "id": reel_id,
        "title": title,
        "filename": f"reels/{filename}",
        "thumbnail": thumbnail,
        "media_count": parse_int(request.form.get("media_count"), 0),
        "duration": round(parse_float(request.form.get("duration"), 0.0), 1),
        "song_name": (request.form.get("song_name") or "No music").strip()[:80],
        "caption": (request.form.get("caption") or "").strip()[:160],
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }

    reels = load_reels()
    reels.insert(0, record)
    save_reels(reels)

    return jsonify(
        {
            "message": "Reel saved.",
            "reel": record,
            "reel_url": url_for("static", filename=record["filename"]),
            "gallery_url": url_for("gallery"),
        }
    )


@app.route("/gallery")
def gallery():
    return render_template("gallery.html", reels=load_reels())


if __name__ == "__main__":
    ensure_storage()
    app.run(debug=True)
