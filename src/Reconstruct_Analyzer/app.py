"""Vercel WSGI entrypoint for KOLAM."""
from backend.app import create_app

app = create_app()
