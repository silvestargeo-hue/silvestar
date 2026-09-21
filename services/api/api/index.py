"""Vercel serverless entrypoint for the Silvestar API (ASGI adapter)."""
import os

from app.main import app

# Vercel maps /api/v1/* serverless routes onto this app.
application = app
