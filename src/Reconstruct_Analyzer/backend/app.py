"""Flask application factory for the KOLAM API (analyzer + reconstructor only)."""
from flask import Flask, jsonify

from backend.routes.api import api


def create_app(test_config=None):
    app = Flask(__name__, static_folder=None)
    app.config.update(
        # Vercel Functions cap request/response payloads at 4.5 MB.
        MAX_CONTENT_LENGTH=4 * 1024 * 1024,
        JSON_SORT_KEYS=False,
    )
    if test_config:
        app.config.update(test_config)

    app.register_blueprint(api)

    @app.after_request
    def cache_policy(response):
        response.headers["Cache-Control"] = "no-store, max-age=0"
        return response

    @app.errorhandler(413)
    def too_large(_error):
        return jsonify({"error": "Image is too large. Maximum upload size is 4 MB."}), 413

    @app.errorhandler(404)
    def not_found(_error):
        return jsonify({"error": "Route not found."}), 404

    return app
