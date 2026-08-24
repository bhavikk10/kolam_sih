"""JSON and image endpoints used by the KOLAM frontend."""
from io import BytesIO

from flask import Blueprint, jsonify, request, send_file
from PIL import Image, UnidentifiedImageError

from backend.services.hybrid_vision import HybridVisionEngine
from backend.services.kolam_recreator import KolamRecreatorService

api = Blueprint("api", __name__, url_prefix="/api")
hybrid = HybridVisionEngine()
recreator = KolamRecreatorService()

ALLOWED_FORMATS = {"PNG", "JPEG", "WEBP", "BMP", "GIF"}


def _read_image():
    upload = request.files.get("image")
    if upload is None or not upload.filename:
        return None, (jsonify({"error": "Upload an image in the 'image' form field."}), 400)
    try:
        image = Image.open(upload.stream)
        image.load()
        if image.format and image.format.upper() not in ALLOWED_FORMATS:
            return None, (jsonify({"error": f"Unsupported image format: {image.format}."}), 415)
        return image.convert("RGB"), None
    except (UnidentifiedImageError, OSError):
        return None, (jsonify({"error": "The uploaded file is not a readable image."}), 415)


@api.get("/health")
def health():
    return jsonify(
        {
            "status": "ok",
            "service": "KOLAM Vision API",
            "version": "1.0.0",
            "defaultEngine": "hybrid",
            "analyzerReady": True,
            "recreatorReady": True,
        }
    )


@api.get("/model/info")
def model_info():
    return jsonify(
        {
            "name": "KOLAM Vision Engine",
            "version": "1.0.0",
            "runtimeModel": {
                "id": "kolam-hybrid-v1",
                "type": "Explainable computer-vision pipeline",
                "trained": False,
                "components": [
                    "background-aware ink segmentation",
                    "fuzzy bilateral and rotational symmetry scoring",
                    "dot-lattice detection",
                    "16-class geometric tile-template classifier",
                ],
            },
            "recreatorModel": {
                "id": "kolam-recreator-v1",
                "type": "Known-tile digital rebuilder with clean-trace fallback",
                "trained": False,
                "methods": ["auto", "tiles", "trace"],
                "note": "Recreates a complete uploaded kolam as a clean digital rendering.",
            },
        }
    )


@api.get("/docs")
def api_docs():
    return jsonify(
        {
            "service": "KOLAM Vision API",
            "endpoints": {
                "GET /api/health": "Backend and model readiness",
                "GET /api/model/info": "Transparent runtime-model description",
                "POST /api/analyze": "Multipart image -> symmetry, lattice, tile, and accuracy metrics",
                "POST /api/recreate": "Multipart complete image + method + palette -> clean recreated PNG",
            },
        }
    )


@api.post("/analyze")
def analyze():
    image, error = _read_image()
    if error:
        return error
    result = hybrid.analyze(image)
    result["engine"] = "kolam-hybrid-v1"
    return jsonify(result)


@api.post("/recreate")
def recreate_kolam():
    """Rebuild a complete uploaded kolam as a clean digital rendering."""
    image, error = _read_image()
    if error:
        return error

    method = request.form.get("method", "auto")
    palette = request.form.get("palette", "heritage")
    thickness = request.form.get("thickness", "2")
    try:
        output, metadata = recreator.recreate(
            image, method=method, palette=palette, thickness=thickness
        )
    except (ValueError, TypeError) as error:
        return jsonify({"error": str(error)}), 422

    buffer = BytesIO()
    output.save(buffer, format="PNG", optimize=True)
    buffer.seek(0)
    response = send_file(
        buffer,
        mimetype="image/png",
        download_name="kolam-recreated.png",
    )
    response.headers["X-Kolam-Engine"] = metadata["engine"]
    response.headers["X-Kolam-Method"] = metadata["method"]
    response.headers["X-Kolam-Palette"] = metadata["palette"]
    response.headers["X-Kolam-Confidence"] = str(metadata["confidence"])
    response.headers["X-Kolam-Grid"] = metadata["grid"]
    response.headers["X-Kolam-Grid-Regularity"] = str(metadata["gridRegularity"])
    response.headers["X-Kolam-Tile-Confidence"] = str(metadata["tileConfidence"])
    response.headers["X-Kolam-Symmetry"] = str(metadata["symmetry"])
    response.headers["X-Kolam-Cells"] = str(metadata["cells"])
    return response
